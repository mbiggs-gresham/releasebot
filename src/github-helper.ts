import * as core from '@actions/core'
import * as github from '@actions/github'
import { Endpoints } from '@octokit/types'
import { PushEvent } from '@octokit/webhooks-types'
import { GitHub } from '@actions/github/lib/utils'
import { minimatch } from 'minimatch'
import * as semver from 'semver'
import * as versions from './version-helper'
import * as base64 from './base64-helper'
import { hidden, important } from './markdown'

type AddLabelResponse = Endpoints['POST /repos/{owner}/{repo}/issues/{issue_number}/labels']['response']

type CreateReactionResponse = Endpoints['POST /repos/{owner}/{repo}/issues/{issue_number}/reactions']['response']

type GetContentResponse = Endpoints['GET /repos/{owner}/{repo}/contents/{path}']['response']
type CreateOrUpdateFileContentsResponse = Endpoints['PUT /repos/{owner}/{repo}/contents/{path}']['response']

type CreateBranchResponse = Endpoints['POST /repos/{owner}/{repo}/git/refs']['response']
type UpdateBranchResponse = Endpoints['PATCH /repos/{owner}/{repo}/git/refs/{ref}']['response']

type ListBranchesResponse = Endpoints['GET /repos/{owner}/{repo}/branches']['response']

type ListTagsResponse = Endpoints['GET /repos/{owner}/{repo}/git/matching-refs/{ref}']['response']
type Tag = ListTagsResponse['data'][0]

type CreatePullRequestResponse = Endpoints['POST /repos/{owner}/{repo}/pulls']['response']
type CreatedPullRequest = CreatePullRequestResponse['data']

type ListPullRequestsResponse = Endpoints['GET /repos/{owner}/{repo}/pulls']['response']
type PullRequest = ListPullRequestsResponse['data'][0]

type CreateCommentResponse = Endpoints['POST /repos/{owner}/{repo}/issues/{issue_number}/comments']['response']
type UpdateCommentResponse = Endpoints['PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}']['response']
type DeleteCommentResponse = Endpoints['DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}']['response']
type ListCommentsResponse = Endpoints['GET /repos/{owner}/{repo}/issues/{issue_number}/comments']['response']
type Comment = ListCommentsResponse['data'][0]

export type Version = 'major' | 'minor' | 'patch'
export type Reaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'

export enum Commands {
  Rebase = '@releasebot rebase',
  Recreate = '@releasebot recreate',
  SetVersion = '@releasebot setversion'
}

const projects = ['core', 'grid']
const projectsPaths = ['core/*', 'grid/*']
const projectsEcosystem = ['npm', 'npm']

export function extractProjectNameFromPR(text: string): string | null {
  const match = text.match(/\[\/\/]:\s#\s\(releasebot-project:(\w+)\)/)
  return match ? match[1] : null
}

/**
 * Get the release branch name for the project.
 * @param project
 */
export function getReleaseBranchName(project: string): string {
  return `releasebot-${project}`
}

/**
 * Get the title for the PR.
 * @param project
 * @param nextVersion
 */
function getPullRequestTitle(project: string, nextVersion: string): string {
  return `Release \`${project}\` v${nextVersion}`
}

/**
 * Get the default next version.
 */
function getDefaultNextVersion(): string {
  return '0.0.1'
}

/**
 * Return the body of the PR text.
 * @param project
 * @param nextVersion
 * @param rebasing
 */
function getPullRequestBody(project: string, nextVersion: string, rebasing: boolean = false): string {
  const body: string[] = []

  if (rebasing) {
    body.push(`${hidden('releasebot-start')}\n${important('Releasebot is rebasing this PR')}\n${hidden('releasebot-end')}\n`)
  }

  body.push(`
  This PR was created automatically by the Releasebot to track the next release. 
  The next version for this release is v${nextVersion}.

  ---

  <details>
  <summary>Releasebot commands and options</summary>
  <br />
  
  You can trigger Releasebot actions by commenting on this PR:
  - \`@releasebot rebase\` will rebase this PR
  - \`@releasebot recreate\` will recreate this PR, overwriting any edits that have been made to it
  - \`@releasebot setversion [major|minor|patch]\` will set the version for this PR
  </details>
  `)

  return body.join('')
}

/**
 * List all files that were added, modified, or removed in the push event.
 * @param octokit
 * @param payload
 */
export async function listPushCommitFiles(octokit: InstanceType<typeof GitHub>, payload: PushEvent): Promise<string[]> {
  const files = new Set<string>()

  // If the push event has a list of commits, use that to get the list of files, otherwise
  // get the list of files from the commit details.
  for (const commit of payload.commits) {
    if (commit.added || commit.modified || commit.removed) {
      core.debug(`Commit contained file details: ${JSON.stringify(commit, null, 2)}`)
      commit.added.forEach(file => files.add(file))
      commit.modified.forEach(file => files.add(file))
      commit.removed.forEach(file => files.add(file))
    } else {
      core.debug(`Commit contained no file details. Getting commit details for: ${payload.after}`)
      const { data: commitDetails } = await octokit.rest.repos.getCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        ref: payload.after
      })
      core.debug(`Commit Details: ${JSON.stringify(commitDetails, null, 2)}`)
      commitDetails.files?.forEach(file => files.add(file.filename))
    }
  }

  return Array.from(files)
}

/**
 * List all projects that are relevant to the files that were changed.
 * @param files
 */
export async function listProjectsOfRelevance(files: string[]): Promise<string[]> {
  const relevantProjects = new Set<string>()
  files.forEach(file => {
    projects.forEach((project, index) => {
      if (minimatch(file, projectsPaths[index])) {
        relevantProjects.add(project)
      }
    })
  })
  return Array.from(relevantProjects)
}

/**
 * Get the next version for the project.
 * @param octokit
 * @param project
 * @param versionType
 */
export async function getNextVersion(octokit: InstanceType<typeof GitHub>, project: string, versionType: Version): Promise<string> {
  // Check if there is an existing tag for the project
  const tags = await listTags(octokit, project)
  if (tags.length > 0) {
    const lastTag = tags[tags.length - 1]
    const lastTagName = lastTag.ref.substring('refs/tags/'.length)
    const lastTagVersion = lastTagName.substring(`${project}@v`.length)

    // Check if there is an existing PR for the release branch
    // and if it has a set version command in the comments
    const releaseBranchPR = await findPullRequest(octokit, project)
    if (releaseBranchPR) {
      const comments: Comment[] = await listComments(octokit, releaseBranchPR.number)
      for (let i = comments.length - 1; i >= 0; i--) {
        const lastCommentBody = comments[i].body
        if (lastCommentBody?.startsWith(Commands.SetVersion)) {
          core.info(`Found setversion command in comment: ${lastCommentBody}`)
          const nextVersionType = lastCommentBody.split(' ')[2]
          const nextVersion = semver.inc(lastTagVersion, nextVersionType as Version)
          if (nextVersion) {
            return nextVersion
          }
        }
      }
    }

    // Bump the version using semver
    const nextVersion = semver.inc(lastTagVersion, versionType)
    if (nextVersion) {
      return nextVersion
    } else {
      core.setFailed(`Invalid last tag version: ${lastTagVersion}. Must be of the format '${project}@vX.X.X'`)
    }
  }

  core.warning(`No tags found for project: ${project}. Using default next version.`)
  return getDefaultNextVersion()
}

/**
 * Update the version for the project.
 * @param octokit
 * @param project
 * @param branch
 * @param version
 */
export async function setVersion(octokit: InstanceType<typeof GitHub>, project: string, branch: string, version: string): Promise<void> {
  core.info(`Updating ${project} version to ${version}`)
  const { data: existingFile }: GetContentResponse = await octokit.rest.repos.getContent({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    path: `${project}/package.json`,
    ref: branch
  })
  core.debug(`Existing File: ${JSON.stringify(existingFile, null, 2)}`)

  if (!Array.isArray(existingFile)) {
    if (existingFile.type === 'file' && existingFile.size > 0) {
      const existingFileContents = base64.decode(existingFile.content)
      const newFileContents = versions.patchPackageJson(existingFileContents, version)

      if (core.isDebug()) {
        core.startGroup('File Contents')
        core.debug(`Existing File Contents: ${existingFileContents}`)
        core.debug(`New File Contents: ${newFileContents}`)
        core.endGroup()
      }

      const newFile: CreateOrUpdateFileContentsResponse = await octokit.rest.repos.createOrUpdateFileContents({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: `${project}/package.json`,
        branch: branch,
        sha: existingFile.sha,
        message: `Update ${project} version to v${version}`,
        content: base64.encode(newFileContents)
      })
      core.debug(`Updated File: ${JSON.stringify(newFile, null, 2)}`)
    } else {
      core.setFailed('Existing file is not a file')
    }
  }
}

/**
 * Check if the release branch exists for the project.
 * @param octokit
 * @param project
 */
export async function releaseBranchExists(octokit: InstanceType<typeof GitHub>, project: string): Promise<boolean> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branches: ListBranchesResponse = await octokit.rest.repos.listBranches({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo
  })
  return branches.data.some(branch => branch.name === releaseBranch)
}

/**
 * Create a release branch for the project and commit the next version.
 * @param octokit
 * @param project
 */
export async function createReleaseBranch(octokit: InstanceType<typeof GitHub>, project: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)

  core.info(`Creating new branch: ${releaseBranch}`)
  const branch: CreateBranchResponse = await octokit.rest.git.createRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `refs/heads/${releaseBranch}`,
    sha: github.context.sha
  })
  core.debug(`Created Branch: ${JSON.stringify(branch, null, 2)}`)
}

/**
 * Recreate a release branch for the project and commit the next version.
 * @param octokit
 * @param project
 */
export async function recreateReleaseBranch(octokit: InstanceType<typeof GitHub>, project: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)

  core.info(`Recreating existing branch: ${releaseBranch}`)
  const branch: UpdateBranchResponse = await octokit.rest.git.updateRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `heads/${releaseBranch}`,
    sha: github.context.sha,
    force: true
  })
  core.debug(`Recreated Branch: ${JSON.stringify(branch, null, 2)}`)
}

/**
 * Find the PR for the release branch.
 * @param octokit
 * @param project
 */
export async function findPullRequest(octokit: InstanceType<typeof GitHub>, project: string): Promise<PullRequest | undefined> {
  const releaseBranch: string = getReleaseBranchName(project)

  const pulls: ListPullRequestsResponse = await octokit.rest.pulls.list({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    head: `${github.context.repo.owner}:${releaseBranch}`,
    state: 'open'
  })
  core.debug(`Pulls: ${JSON.stringify(pulls, null, 2)}`)

  for (const pull of pulls.data) {
    if (pull.labels.find(label => label.name === 'release')) {
      core.info(`Found existing PR for branch: ${releaseBranch}`)
      return pull
    }
  }

  return undefined
}

/**
 * Create a draft PR for the release branch.
 * @param octokit
 * @param project
 */
export async function createPullRequest(octokit: InstanceType<typeof GitHub>, project: string): Promise<CreatedPullRequest> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branch = github.context.ref.substring('refs/heads/'.length)

  core.info(`Creating new PR for branch: ${releaseBranch}`)
  const nextVersion = await getNextVersion(octokit, project, 'patch')
  const pull: CreatePullRequestResponse = await octokit.rest.pulls.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    title: getPullRequestTitle(project, nextVersion),
    body: getPullRequestBody(project, nextVersion),
    head: releaseBranch,
    base: branch,
    draft: true
  })
  core.debug(`Created Pull: ${JSON.stringify(pull, null, 2)}`)

  const label: AddLabelResponse = await octokit.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull.data.number,
    labels: ['release', project]
  })
  core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)

  return pull.data
}

/**
 * Update the PR for the release branch.
 * @param octokit
 * @param pull_number
 * @param project
 * @param nextVersion
 * @param rebasing
 */
export async function updatePullRequest(octokit: InstanceType<typeof GitHub>, pull_number: number, project: string, nextVersion: string, rebasing: boolean = false): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branch = github.context.ref.substring('refs/heads/'.length)

  core.info(`Updating existing PR for branch: ${releaseBranch}`)
  const pull = await octokit.rest.pulls.update({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pull_number,
    title: getPullRequestTitle(project, nextVersion),
    body: getPullRequestBody(project, nextVersion, rebasing),
    head: releaseBranch,
    base: branch,
    draft: true
  })
  core.debug(`Updated Pull: ${JSON.stringify(pull, null, 2)}`)

  const label: AddLabelResponse = await octokit.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull_number,
    labels: ['release', project]
  })
  core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
}

/**
 * List all tags for the project.
 * @param octokit
 * @param project
 */
export async function listTags(octokit: InstanceType<typeof GitHub>, project: string): Promise<Tag[]> {
  const tags: ListTagsResponse = await octokit.rest.git.listMatchingRefs({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `tags/${project}`
  })
  return tags.data
}

/**
 * Add a reaction to a comment.
 * @param octokit
 * @param comment_number
 * @param reaction
 */
export async function addReaction(octokit: InstanceType<typeof GitHub>, comment_number: number, reaction: Reaction): Promise<void> {
  const response: CreateReactionResponse = await octokit.rest.reactions.createForIssueComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    comment_id: comment_number,
    content: reaction
  })
  core.debug(`Added Reaction: ${JSON.stringify(response, null, 2)}`)
}

/**
 * Add or update a comment on a PR.
 * @param octokit
 * @param pull_number
 * @param body
 */
export async function addOrUpdateComment(octokit: InstanceType<typeof GitHub>, pull_number: number, body: string): Promise<Comment> {
  const comments: Comment[] = await listComments(octokit, pull_number)
  if (comments.length > 0) {
    const lastComment = comments[comments.length - 1]
    if (lastComment.body === body) {
      return await updateComment(octokit, lastComment.id, body)
    } else {
      return await createComment(octokit, pull_number, body)
    }
  } else {
    return await createComment(octokit, pull_number, body)
  }
}

/**
 * List all comments on a PR.
 * @param octokit
 * @param pull_number
 */
export async function listComments(octokit: InstanceType<typeof GitHub>, pull_number: number): Promise<Comment[]> {
  const comments: ListCommentsResponse = await octokit.rest.issues.listComments({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull_number
  })
  core.debug(`List Comments: ${JSON.stringify(comments, null, 2)}`)
  return comments.data
}

/**
 * Add a comment to a PR.
 * @param octokit
 * @param pull_number
 * @param body
 */
export async function createComment(octokit: InstanceType<typeof GitHub>, pull_number: number, body: string): Promise<Comment> {
  const response: CreateCommentResponse = await octokit.rest.issues.createComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull_number,
    body: body
  })
  core.debug(`Added Comment: ${JSON.stringify(response, null, 2)}`)
  return response.data
}

/**
 * Update a comment on a PR.
 * @param octokit
 * @param comment_id
 * @param body
 */
export async function updateComment(octokit: InstanceType<typeof GitHub>, comment_id: number, body: string): Promise<Comment> {
  const response: UpdateCommentResponse = await octokit.rest.issues.updateComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    comment_id: comment_id,
    body: body
  })
  core.debug(`Updated Comment: ${JSON.stringify(response, null, 2)}`)
  return response.data
}

/**
 * Delete a comment on a PR.
 * @param octokit
 * @param comment_id
 */
export async function deleteComment(octokit: InstanceType<typeof GitHub>, comment_id: number): Promise<void> {
  const response: DeleteCommentResponse = await octokit.rest.issues.deleteComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    comment_id: comment_id
  })
  core.debug(`Deleted Comment: ${JSON.stringify(response, null, 2)}`)
}
