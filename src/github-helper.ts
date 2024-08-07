import * as core from '@actions/core'
import * as github from '@actions/github'
import { Endpoints } from '@octokit/types'
import { PullRequest, PushEvent } from '@octokit/webhooks-types'
import { GitHub } from '@actions/github/lib/utils'
import { minimatch } from 'minimatch'
import * as semver from 'semver'
import * as versions from './version-helper'
import * as base64 from './base64-helper'

type GetCommit = Endpoints['GET /repos/{owner}/{repo}/commits/{ref}']['response']
type Pulls = Endpoints['GET /repos/{owner}/{repo}/pulls']['response']
type ListPulls = Endpoints['GET /repos/{owner}/{repo}/pulls']['response']

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

/**
 * Get the release branch name for the project.
 * @param project
 */
function getReleaseBranchName(project: string): string {
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
 * @param nextVersion
 * @param rebasing
 */
function getPullRequestBody(nextVersion: string, rebasing: boolean = false): string {
  const body: string[] = []

  if (rebasing) {
    body.push(`
  [//]: # (releasebot-start)
    ⚠️  **Releasebot is rebasing this PR** ⚠️
    
    Rebasing might not happen immediately, so don't worry if this takes some time.
    
    Note: if you make any changes to this PR yourself, they will take precedence over the rebase.
    
    ---
    
  [//]: # (releasebot-end)
    `)
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
 * List all files that were added, modified, or removed in the push event that are relevant to the projects defined in config.
 * @param files
 */
export async function listPushCommitFilesOfRelevance(files: string[]): Promise<string[]> {
  const relevantFiles = new Set<string>()
  files.forEach(file => {
    projects.forEach((project, index) => {
      if (minimatch(file, projectsPaths[index])) {
        relevantFiles.add(file)
      }
    })
  })
  return Array.from(relevantFiles)
}

/**
 * Get the next version for the project.
 * @param octokit
 * @param project
 * @param versionType
 */
export async function getNextVersion(octokit: InstanceType<typeof GitHub>, project: string, versionType: Version): Promise<string> {
  const { data: tags } = await octokit.rest.git.listMatchingRefs({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `tags/${project}`
  })
  core.debug(`Tags: ${JSON.stringify(tags, null, 2)}`)

  if (tags.length > 0) {
    const lastTag = tags[tags.length - 1]
    const lastTagName = lastTag.ref.substring('refs/tags/'.length)
    const lastTagVersion = lastTagName.substring(`${project}@v`.length)
    const nextTagVersion = semver.inc(lastTagVersion, versionType)
    if (nextTagVersion) {
      return nextTagVersion
    } else {
      core.setFailed(`Invalid last tag version: ${lastTagVersion}. Must be of the format '${project}@vX.X.X'`)
    }
  } else {
    core.setFailed(`No tags found for project: ${project}. Unable to determine the latest version.`)
  }

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
  const { data: existingFile } = await octokit.rest.repos.getContent({
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

      await octokit.rest.repos.createOrUpdateFileContents({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: `${project}/package.json`,
        branch: branch,
        sha: existingFile.sha,
        message: `Update ${project} version to v${version}`,
        content: base64.encode(newFileContents)
      })
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
  const { data: branches } = await octokit.rest.repos.listBranches({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo
  })
  return branches.some(branch => branch.name === releaseBranch)
}

/**
 * Create a release branch for the project and commit the next version.
 * @param octokit
 * @param project
 */
export async function createReleaseBranch(octokit: InstanceType<typeof GitHub>, project: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)

  core.info(`Creating new branch: ${releaseBranch}`)
  const branch = await octokit.rest.git.createRef({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `refs/heads/${releaseBranch}`,
    sha: github.context.sha
  })
  core.debug(`Created Branch: ${JSON.stringify(branch, null, 2)}`)

  const nextVersion = await getNextVersion(octokit, project, 'patch')
  await setVersion(octokit, project, releaseBranch, nextVersion)
}

/**
 * Find the PR for the release branch.
 * @param octokit
 * @param project
 */
export async function findPullRequest(octokit: InstanceType<typeof GitHub>, project: string): Promise<PullRequest | undefined> {
  const releaseBranch: string = getReleaseBranchName(project)

  const { data: pulls } = await octokit.rest.pulls.list({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    head: `${github.context.repo.owner}:${releaseBranch}`
  })

  core.debug(`Pulls: ${JSON.stringify(pulls, null, 2)}`)
  for (const pull of pulls) {
    if (pull.labels.find(label => label.name === 'release')) {
      core.info(`Found existing PR for branch: ${releaseBranch}`)
      return pull as PullRequest
    }
  }

  return undefined
}

/**
 * Create a draft PR for the release branch.
 * @param octokit
 * @param project
 */
export async function createPullRequest(octokit: InstanceType<typeof GitHub>, project: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branch = github.context.ref.substring('refs/heads/'.length)

  core.info(`Creating new PR for branch: ${releaseBranch}`)
  const nextVersion = await getNextVersion(octokit, project, 'patch')
  const pull = await octokit.rest.pulls.create({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    title: getPullRequestTitle(project, nextVersion),
    body: getPullRequestBody(nextVersion),
    head: releaseBranch,
    base: branch,
    draft: true
  })
  core.debug(`Created Pull: ${JSON.stringify(pull, null, 2)}`)

  const label = await octokit.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull.data.number,
    labels: ['release', project]
  })
  core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
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
    body: getPullRequestBody(nextVersion, rebasing),
    head: releaseBranch,
    base: branch,
    draft: true
  })
  core.debug(`Updated Pull: ${JSON.stringify(pull, null, 2)}`)

  const label = await octokit.rest.issues.addLabels({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    issue_number: pull_number,
    labels: ['release', project]
  })
  core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
}

/**
 * Add a reaction to a comment.
 * @param octokit
 * @param comment_number
 * @param reaction
 */
export async function addReaction(octokit: InstanceType<typeof GitHub>, comment_number: number, reaction: Reaction): Promise<void> {
  const result = await octokit.rest.reactions.createForIssueComment({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    comment_id: comment_number,
    content: reaction
  })
  core.debug(`Added Reaction: ${JSON.stringify(result, null, 2)}`)
}
