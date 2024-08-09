import * as core from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from 'octokit'
import { PushEvent } from '@octokit/webhooks-types'
import { minimatch } from 'minimatch'
import * as semver from 'semver'
import * as versions from './version-helper'
import * as base64 from './base64-helper'
import { hidden, important } from './markdown'
import { GraphQlQueryResponseData } from '@octokit/graphql'

export interface Branch {
  id: string
  name: string
}

export interface Branches {
  branches: Branch[]
}

export interface Tag {
  id: string
  name: string
}

export interface Tags {
  tags: Tag[]
}

export interface Label {
  id: string
  name: string
}

export interface Comment {
  id: string
  author: {
    login: string
  }
  body: string
}

export interface Comments {
  comments: Comment[]
}

export interface PullRequest {
  id: string
  number: number
  title: string
  body: string
  createdAt: string
  lastEditedAt: string
  baseRefName: string
  baseRefOid: string
  headRefName: string
  headRefOid: string
  comments: Comments
}

export interface PullRequests {
  pullRequests: PullRequest[]
}

export interface KrytenbotDraftRelease {
  id: string
  tags: Tags
  branches: Branches
  releaseLabel: Label
  projectLabel: Label
  pullRequests: PullRequests
}

export type Version = 'major' | 'minor' | 'patch'
export type Reaction = 'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES'

export enum Commands {
  Rebase = '@krytenbot rebase',
  Recreate = '@krytenbot recreate',
  SetVersion = '@krytenbot setversion'
}

const projects = ['core', 'grid']
const projectsPaths = ['core/*', 'grid/*']
const projectsEcosystem = ['npm', 'npm']

function addReactionMutation(): string {
  return `
    mutation AddReaction($subjectId: ID!, $content: ReactionContent!) {
        addReaction(input:{ clientMutationId: "krytenbot", subjectId: $subjectId, content: $content }) {
            reaction {
                content
            }
            subject {
                id
            }
        }
    }`
}

function createRefMutation(): string {
  return `
    mutation CreateRef($repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
        createRef(input:{ repositoryId: $repositoryId, name: $name, oid: $oid }) {
            ref {
                name
                target {
                    oid
                }
            }
        }
    }`
}

function updateRefMutation(): string {
  return `
    mutation UpdateRef($refId: ID!, $oid: GitObjectID!) {
        updateRef(input:{ clientMutationId: "krytenbot", refId: $refId, oid: $oid, force: true }) {
            ref {
                name
                target {
                    oid
                }
            }
        }
    }`
}

function createCommitOnBranchMutation(): string {
  return `
    mutation CreateCommitOnBranch($branch: CommittableBranch!, $message: CommitMessage!, $expectedHeadOid: GitObjectID!, $fileChanges: FileChanges) {
        createCommitOnBranch(input:{ clientMutationId: "krytenbot", branch: $branch, message: $message, expectedHeadOid: $expectedHeadOid, fileChanges: $fileChanges }) {
            commit {
                oid
            }
        }
    }`
}

function createPullRequestMutation(): string {
  return `
    mutation CreatePullRequest($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String!) {
        createPullRequest(input:{ clientMutationId: "krytenbot", repositoryId: $repositoryId, baseRefName: $baseRefName, headRefName: $headRefName, title: $title, body: $body, draft: true }) {
            pullRequest {
                id
            }
        }
    }`
}

function updatePullRequestLabelsMutation(): string {
  return `
    mutation UpdatePullRequestLabels($pullRequestId: ID!, $labelIds: [ID!]) {
        updatePullRequest(input:{ clientMutationId: "krytenbot", pullRequestId: $pullRequestId, labelIds: $labelIds }) {
            pullRequest {
                id
            }
        }
    }`
}

function updatePullRequestTitleMutation(): string {
  return `
    mutation UpdatePullRequestLabels($pullRequestId: ID!, $title: String) {
        updatePullRequest(input:{ clientMutationId: "krytenbot", pullRequestId: $pullRequestId, title: $title }) {
            pullRequest {
                id
            }
        }
    }`
}

function updatePullRequestBranchMutation(): string {
  return `
    mutation UpdatePullRequestBranch($pullRequestId: ID!) {
        updatePullRequestBranch(input:{ clientMutationId: "krytenbot", pullRequestId: $pullRequestId, updateMethod: REBASE }) {
            pullRequest {
                id
            }
        }
    }`
}

function addCommentMutation(): string {
  return `
    mutation AddPullRequestComment($subjectId: ID!, $body: String!) {
        addComment(input:{ subjectId: $subjectId, body: $body }) {            
            subject {
                id
            }
        }
    }`
}

function findRefQuery(): string {
  return `
    query FindRef($owner: String!, $repo: String!, $ref: String!) {
        repository(owner: $owner, name: $repo) {
            ref(qualifiedName: $ref) {
                name
            }
        }
    }`
}

function getFileContentQuery(): string {
  return `
    query GetFileContent($owner: String!, $repo: String!, $ref: String!) {
        repository(owner: $owner, name: $repo) {
              file: object(expression: $ref) {
                  ... on Blob {
                      content: text
                  }
              }
        }
    }`
}

function findCommitQuery(): string {
  return `
    query FindCommit($owner: String!, $repo: String!, $oid: GitObjectID!) {
        repository(owner: $owner, name: $repo) {
            object(oid: $oid) {
                ... on Commit {
                    oid
                    message
                    changedFilesIfAvailable           
                    tree {
                       entries { 
                          name
                          path
                       }
                    }
                    history(first: 1) {
                        nodes {
                            id
                            oid
                            message
                            changedFiles
                            tree {
                              entries {
                                name
                                path
                              }                            
                            }
                        }
                    }
                }
            }
        }
    }`
}

function findDraftReleaseQuery(): string {
  return `
    query FindDraftRelease ($owner: String!, $repo: String!, $project: String!, $branch: String!, $labels: [String!]){
        repository(owner: $owner, name: $repo) {
              id
              tags: refs(last: 20, refPrefix: "refs/tags/", query: $project) {
                  tags: nodes {
                      id
                      name
                  }
              }
              branches: refs(last: 20, refPrefix: "refs/heads/", query: $branch) {
                  branches: nodes {
                      id
                      name
                  }
              }
              releaseLabel: label(name: "release") {
                  id
                  name
              }
              projectLabel: label(name: $project) {
                  id
                  name
              }
              pullRequests(last: 1, labels: $labels, states: OPEN) {
                  pullRequests: nodes {
                      id
                      number
                      title
                      body
                      createdAt
                      lastEditedAt
                      baseRefName
                      baseRefOid
                      headRefName
                      headRefOid
                      author {
                          login
                      }
                      comments(last: 10) {
                          comments: nodes {
                              id
                              author {
                                  login
                              }
                              body
                          }
                      }
                  }
              }
          }
    }`
}

function findPullRequestIdQuery(): string {
  return `
    query FindPullRequestID ($owner: String!, $repo: String!, $pullNumber: Int!){
        repository(owner:$owner, name:$repo) {
            pullRequest(number:$pullNumber) {
                id
            }
        }
    }`
}

export function extractProjectNameFromPR(text: string): string | null {
  const match = text.match(/\[\/\/]:\s#\s\(krytenbot-project:(\w+)\)/)
  return match ? match[1] : null
}

/**
 * Get the release branch name for the project.
 * @param project
 */
export function getReleaseBranchName(project: string): string {
  return `krytenbot-${project}`
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

  body.push(hidden(`krytenbot-project:${project}`))
  body.push('\n')

  if (rebasing) {
    body.push(hidden('krytenbot-start'))
    body.push('\n\n')
    body.push(important('Krytenbot is rebasing this PR'))
    body.push('\n\n')
    body.push(hidden('krytenbot-end'))
    body.push('\n')
  }

  body.push(`
This PR was created automatically by the Krytenbot to track the next release. 
The next version for this release is v${nextVersion}.

---

<details>
<summary>Krytenbot commands and options</summary>
<br />

You can trigger Krytenbot actions by commenting on this PR:
- \`@krytenbot rebase\` will rebase this PR
- \`@krytenbot recreate\` will recreate this PR, overwriting any edits that have been made to it
- \`@krytenbot setversion [major|minor|patch]\` will set the version for this PR
</details>
  `)

  return body.join('')
}

/**
 * List all files that were added, modified, or removed in the push event.
 * @param octokit
 * @param payload
 */
export async function listPushCommitFiles(octokit: Octokit, payload: PushEvent): Promise<string[]> {
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
      // const commitDetails = await octokit.graphql(findCommitQuery(), {
      //   owner: github.context.repo.owner,
      //   repo: github.context.repo.repo,
      //   oid: payload.after
      // })

      core.info(`Commit Details: ${JSON.stringify(commitDetails, null, 2)}`)
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
 * Update the version for the project.
 * @param octokit
 * @param project
 * @param version
 * @param sha
 */
export async function setReleaseBranchVersion(octokit: Octokit, project: string, version: string, sha: string): Promise<void> {
  const branch: string = getReleaseBranchName(project)

  const {
    repository: { file: existingFile }
  }: GraphQlQueryResponseData = await octokit.graphql(getFileContentQuery(), {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    ref: `${branch}:${project}/package.json`
  })
  core.debug(`Existing File: ${JSON.stringify(existingFile, null, 2)}`)

  const newFileContents = versions.patchPackageJson(existingFile.content, version)
  const createCommitOnBranch: GraphQlQueryResponseData = await octokit.graphql(createCommitOnBranchMutation(), {
    branch: {
      repositoryNameWithOwner: `${github.context.repo.owner}/${github.context.repo.repo}`,
      branchName: branch
    },
    message: { headline: `Update ${project} version to v${version}` },
    expectedHeadOid: sha,
    fileChanges: {
      additions: [
        {
          path: `${project}/package.json`,
          contents: base64.encode(newFileContents)
        }
      ]
    }
  })
  core.debug(`Updated File: ${JSON.stringify(createCommitOnBranch, null, 2)}`)
}

// /**
//  * Recreate a release branch for the project and commit the next version.
//  * @param octokit
//  * @param project
//  */
// export async function recreateReleaseBranch(octokit: Octokit, project: string): Promise<void> {
//   const releaseBranch: string = getReleaseBranchName(project)
//
//   core.info(`Recreating existing branch: ${releaseBranch}`)
//   const branch: UpdateBranchResponse = await octokit.rest.git.updateRef({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     ref: `heads/${releaseBranch}`,
//     sha: github.context.sha,
//     force: true
//   })
//   core.debug(`Recreated Branch: ${JSON.stringify(branch, null, 2)}`)
// }

/**
 * Rebase the next calculated version.
 * @param draftRelease
 * @param versionType
 */
export function getNextVersion(draftRelease: KrytenbotDraftRelease, versionType: Version): string {
  for (const tag of draftRelease.tags.tags) {
    const tagName = tag.name
    const tagVersion = tagName.substring(tagName.indexOf('@v') + 2)

    if (draftRelease.pullRequests.pullRequests.length > 0) {
      for (const comment of draftRelease.pullRequests.pullRequests[0]?.comments.comments) {
        const commentBody = comment.body
        if (commentBody.startsWith(Commands.SetVersion)) {
          const nextVersionType = commentBody.split(' ')[2]
          const nextVersion = semver.inc(tagVersion, nextVersionType as Version)
          if (nextVersion) {
            return nextVersion
          }
        }
      }
    }

    const nextVersion = semver.inc(tagVersion, versionType)
    if (nextVersion) {
      return nextVersion
    }
  }

  return getDefaultNextVersion()
}

/**
 * Find the details of the draft release.
 * @param octokit
 * @param project
 */
export async function findDraftRelease(octokit: Octokit, project: string): Promise<KrytenbotDraftRelease> {
  const pullRequests: GraphQlQueryResponseData = await octokit.graphql(findDraftReleaseQuery(), {
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    project: project,
    branch: getReleaseBranchName(project),
    labels: ['release', project]
  })
  core.debug(`Pull Request: ${JSON.stringify(pullRequests, null, 2)}`)
  return pullRequests.repository
}

/**
 * Create a new branch for the release.
 * @param octokit
 * @param draftRelease
 * @param project
 */
export async function createReleaseBranch(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branch: GraphQlQueryResponseData = await octokit.graphql(createRefMutation(), {
    repositoryId: draftRelease.id,
    name: `refs/heads/${releaseBranch}`,
    oid: github.context.sha
  })
  core.debug(`Created Branch: ${JSON.stringify(branch, null, 2)}`)
}

/**
 * Update the draft release branch by rebasing it.
 * @param octokit
 * @param draftRelease
 */
export async function updateReleaseBranch(octokit: Octokit, draftRelease: KrytenbotDraftRelease): Promise<void> {
  const branch: GraphQlQueryResponseData = await octokit.graphql(updatePullRequestBranchMutation(), {
    pullRequestId: draftRelease.pullRequests.pullRequests[0].id
  })
  core.debug(`Updated Branch: ${JSON.stringify(branch, null, 2)}`)
}

/**
 * Recreate the release branch.
 * @param octokit
 * @param draftRelease
 */
export async function recreateReleaseBranch(octokit: Octokit, draftRelease: KrytenbotDraftRelease): Promise<void> {
  const branch: GraphQlQueryResponseData = await octokit.graphql(updateRefMutation(), {
    refId: draftRelease.branches.branches[0].id,
    oid: github.context.sha
  })
  core.debug(`Recreated Branch: ${JSON.stringify(branch, null, 2)}`)
}

/**
 * Create draft release pull request.
 * @param octokit
 * @param draftRelease
 * @param project
 * @param branch
 * @param nextVersion
 */
export async function createPullRequest(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string, branch: string, nextVersion: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)

  const pullRequest: GraphQlQueryResponseData = await octokit.graphql(createPullRequestMutation(), {
    repositoryId: draftRelease.id,
    baseRefName: branch,
    headRefName: releaseBranch,
    title: getPullRequestTitle(project, nextVersion),
    body: getPullRequestBody(project, nextVersion)
  })
  core.debug(`Created pull request: ${JSON.stringify(pullRequest, null, 2)}`)

  const pullRequestLabels: GraphQlQueryResponseData = await octokit.graphql(updatePullRequestLabelsMutation(), {
    pullRequestId: pullRequest.createPullRequest.pullRequest.id,
    labelIds: [draftRelease.releaseLabel.id, draftRelease.projectLabel.id]
  })
  core.debug(`Updated pull requeust labels: ${JSON.stringify(pullRequestLabels, null, 2)}`)
}

/**
 * Add a comment to the pull request.
 * @param octokit
 * @param commentId
 * @param body
 */
export async function addComment(octokit: Octokit, commentId: string, body: string): Promise<void> {
  const response: GraphQlQueryResponseData = await octokit.graphql(addCommentMutation(), {
    subjectId: commentId,
    body: body
  })
  core.debug(`Added comment: ${JSON.stringify(response, null, 2)}`)
}

/**
 * Add a reaction to a comment.
 * @param octokit
 * @param commentId
 * @param reaction
 */
export async function addCommentReaction(octokit: Octokit, commentId: string, reaction: Reaction): Promise<void> {
  const response: GraphQlQueryResponseData = await octokit.graphql(addReactionMutation(), {
    subjectId: commentId,
    content: reaction
  })
  core.debug(`Added comment reaction: ${JSON.stringify(response, null, 2)}`)
}

/**
 * Update the pull request title.
 * @param octokit
 * @param draftRelease
 * @param project
 * @param nextVersion
 */
export async function updatePullRequestTitle(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string, nextVersion: string): Promise<void> {
  const pullRequestLabels: GraphQlQueryResponseData = await octokit.graphql(updatePullRequestTitleMutation(), {
    pullRequestId: draftRelease.pullRequests.pullRequests[0].id,
    title: getPullRequestTitle(project, nextVersion)
  })
  core.debug(`Updated pull request title: ${JSON.stringify(pullRequestLabels, null, 2)}`)
}

//  * Add or update a comment on a PR.
//  * @param octokit
//  * @param pull_number
//  * @param body
//  */
// export async function addOrUpdateComment(octokit: Octokit, pull_number: number, body: string): Promise<Comment> {
//   const comments: Comment[] = await listComments(octokit, pull_number)
//   if (comments.length > 0) {
//     const lastComment = comments[comments.length - 1]
//     if (lastComment.body === body) {
//       return await updateComment(octokit, lastComment.id, body)
//     } else {
//       return await createComment(octokit, pull_number, body)
//     }
//   } else {
//     return await createComment(octokit, pull_number, body)
//   }
// }

// /**
//  * Update a comment on a PR.
//  * @param octokit
//  * @param comment_id
//  * @param body
//  */
// export async function updateComment(octokit: Octokit, comment_id: number, body: string): Promise<Comment> {
//   const response: UpdateCommentResponse = await octokit.rest.issues.updateComment({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     comment_id: comment_id,
//     body: body
//   })
//   core.debug(`Updated Comment: ${JSON.stringify(response, null, 2)}`)
//   return response.data
// }
//
// /**
//  * Delete a comment on a PR.
//  * @param octokit
//  * @param comment_id
//  */
// export async function deleteComment(octokit: Octokit, comment_id: number): Promise<void> {
//   const response: DeleteCommentResponse = await octokit.rest.issues.deleteComment({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     comment_id: comment_id
//   })
//   core.debug(`Deleted Comment: ${JSON.stringify(response, null, 2)}`)
// }
