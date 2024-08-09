import * as core from '@actions/core'
import * as github from '@actions/github'
import { Octokit } from 'octokit'
import { Endpoints } from '@octokit/types'
import { PushEvent } from '@octokit/webhooks-types'
import { minimatch } from 'minimatch'
import * as semver from 'semver'
import * as versions from './version-helper'
import * as base64 from './base64-helper'
import { hidden, important } from './markdown'
import { GraphQlQueryResponseData } from '@octokit/graphql'

interface Branch {
  name: string
}

interface Branches {
  branches: Branch[]
}

interface Tag {
  name: string
}

interface Tags {
  tags: Tag[]
}

interface Comment {
  author: {
    login: string
  }
  body: string
}

interface PullRequest {
  id: string
  number: number
  title: string
  body: string
  createdAt: string
  lastEditedAt: string
  baseRefName: string
  headRefName: string
  comments: Comment[]
}

interface PullRequests {
  pullRequests: PullRequest[]
}

interface KrytenbotDraftRelease {
  id: string
  tags: Tags
  branches: Branches
  pullRequests: PullRequests
}

export type Version = 'major' | 'minor' | 'patch'
export type Reaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'

export enum Commands {
  Rebase = '@krytenbot rebase',
  Recreate = '@krytenbot recreate',
  SetVersion = '@krytenbot setversion'
}

const projects = ['core', 'grid']
const projectsPaths = ['core/*', 'grid/*']
const projectsEcosystem = ['npm', 'npm']

type GetContentResponse = Endpoints['GET /repos/{owner}/{repo}/contents/{path}']['response']

function addReactionToIssueMutation(): string {
  return `
    mutation AddReactionToIssue($subjectId: ID!, $content: ReactionContent!) {
        addReaction(input:{ subjectId:$subjectId, content: $content }) {
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
    mutation CreateRefMutation($repositoryId: ID!, $name: String!, $oid: GitObjectID!) {
        createRef(input:{ repositoryId: $repositoryId, name: $name, oid: $oid }) {
            ref {
                name
            }
        }
    }`
}

function createCommitOnBranchMutation(): string {
  return `
    mutation CreateCommitOnBranchMutation($repositoryId: ID!, $repositoryNameWithOwner: repositoryNameWithOwner!, $branch: CommittableBranch!, $message: CommitMessage!, $expectedHeadOid: GitObjectID!, $fileChanges: FileChanges) {
        createCommitOnBranch(input:{ clientMutationId: "krytenbot", branch: $branch, message: $message, expectedHeadOid: $expectedHeadOid, fileChanges: $fileChanges }) {
            commit {
                oid
            }
        }
    }`
}

function createPullRequestMutation(): string {
  return `
    mutation CreatePullRequestMutation($repositoryId: ID!, $baseRefName: String!, $headRefName: String!, $title: String!, $body: String!) {
        createPullRequest(input:{ clientMutationId: "krytenbot", repositoryId: $repositoryId, baseRefName: $baseRefName, headRefName: $headRefName, title: $title, body: $body, draft: true }) {
            pullRequest {
                id
            }
        }
    }`
}

function updatePullRequestBranchMutation(): string {
  return `
    mutation UpdatePullRequestBranchMutation($pullRequestId: ID!) {
        updatePullRequestBranch(input:{ clientMutationId: "krytenbot", pullRequestId: $pullRequestId, updateMethod: REBASE }) {
            pullRequest {
                id
            }
        }
    }`
}

function addPullRequestCommentMutation(): string {
  return `
    mutation AddPullRequestComment($subjectId: ID!, $body: String!) {
        addComment(input:{ subjectId:$subjectId, body: $body }) {
            commentEdge {
                node {
                    createdAt
                    body
                }
            }
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
                      name
                  }
              }
              branches: refs(last: 20, refPrefix: "refs/heads/", query: $branch) {
                  branches: nodes {
                      name
                  }
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
                      headRefName
                      author {
                          login
                      }
                      comments(last: 10) {
                          comment: nodes {
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

// /**
//  * Get the next version for the project.
//  * @param octokit
//  * @param project
//  * @param versionType
//  */
// export async function getNextVersion(octokit: Octokit, project: string, versionType: Version): Promise<string> {
//   // Check if there is an existing tag for the project
//   const tags = await listTags(octokit, project)
//   if (tags.length > 0) {
//     const lastTag = tags[tags.length - 1]
//     const lastTagName = lastTag.ref.substring('refs/tags/'.length)
//     const lastTagVersion = lastTagName.substring(`${project}@v`.length)
//
//     // Check if there is an existing PR for the release branch
//     // and if it has a set version command in the comments
//     const releaseBranchPR = await findPullRequest(octokit, project)
//     if (releaseBranchPR) {
//       const comments: Comment[] = await listComments(octokit, releaseBranchPR.number)
//       for (let i = comments.length - 1; i >= 0; i--) {
//         const lastCommentBody = comments[i].body
//         if (lastCommentBody?.startsWith(Commands.SetVersion)) {
//           core.info(`Found setversion command in comment: ${lastCommentBody}`)
//           const nextVersionType = lastCommentBody.split(' ')[2]
//           const nextVersion = semver.inc(lastTagVersion, nextVersionType as Version)
//           if (nextVersion) {
//             return nextVersion
//           }
//         }
//       }
//     }
//
//     // Bump the version using semver
//     const nextVersion = semver.inc(lastTagVersion, versionType)
//     if (nextVersion) {
//       return nextVersion
//     } else {
//       core.setFailed(`Invalid last tag version: ${lastTagVersion}. Must be of the format '${project}@vX.X.X'`)
//     }
//   }
//
//   core.warning(`No tags found for project: ${project}. Using default next version.`)
//   return getDefaultNextVersion()
// }

/**
 * Update the version for the project.
 * @param octokit
 * @param project
 * @param branch
 * @param version
 */
export async function setVersion(octokit: Octokit, project: string, branch: string, version: string, sha: string): Promise<void> {
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

      const createCommitOnBranch: GraphQlQueryResponseData = await octokit.graphql(createCommitOnBranchMutation(), {
        repositoryNameWithOwner: {
          repositoryNameWithOwner: `${github.context.repo.owner}/${github.context.repo.repo}`,
          branchName: branch
        },
        message: { body: `Update ${project} version to v${version}` },
        expectedHeadOid: sha,
        fileChanges: [
          {
            deletions: [
              {
                path: `${project}/package.json`
              }
            ],
            additions: [
              {
                path: `${project}/package.json`,
                contents: base64.encode(newFileContents)
              }
            ]
          }
        ]
      })

      // const newFile: CreateOrUpdateFileContentsResponse = await octokit.rest.repos.createOrUpdateFileContents({
      //   owner: github.context.repo.owner,
      //   repo: github.context.repo.repo,
      //   path: `${project}/package.json`,
      //   branch: branch,
      //   sha: existingFile.sha,
      //   message: `Update ${project} version to v${version}`,
      //   content: base64.encode(newFileContents)
      // })
      core.debug(`Updated File: ${JSON.stringify(createCommitOnBranch, null, 2)}`)
    } else {
      core.setFailed('Existing file is not a file')
    }
  }
}

// /**
//  * Check if the release branch exists for the project.
//  * @param octokit
//  * @param project
//  */
// export async function releaseBranchExists(octokit: Octokit, project: string): Promise<boolean> {
//   const releaseBranch: string = getReleaseBranchName(project)
//   const branches: ListBranchesResponse = await octokit.rest.repos.listBranches({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo
//   })
//   return branches.data.some(branch => branch.name === releaseBranch)
// }
//
// /**
//  * Create a release branch for the project and commit the next version.
//  * @param octokit
//  * @param project
//  */
// export async function createReleaseBranch(octokit: Octokit, project: string): Promise<void> {
//   const releaseBranch: string = getReleaseBranchName(project)
//
//   core.info(`Creating new branch: ${releaseBranch}`)
//   const branch: CreateBranchResponse = await octokit.rest.git.createRef({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     ref: `refs/heads/${releaseBranch}`,
//     sha: github.context.sha
//   })
//   core.debug(`Created Branch: ${JSON.stringify(branch, null, 2)}`)
// }
//
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
      for (const comment of draftRelease.pullRequests.pullRequests[0]?.comments) {
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
 * @param sha
 */
export async function createDraftReleaseBranch(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string, sha: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)
  const branch: GraphQlQueryResponseData = await octokit.graphql(createRefMutation(), {
    repositoryId: draftRelease.id,
    name: `refs/heads/${releaseBranch}`,
    oid: sha
  })
  core.debug(`Created Branch: ${JSON.stringify(branch, null, 2)}`)
}

export async function createDraftReleasePullRequest(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string, branch: string, nextVersion: string): Promise<void> {
  const releaseBranch: string = getReleaseBranchName(project)
  // const branch = github.context.ref.substring('refs/heads/'.length)

  core.info(`Creating new PR for branch: ${releaseBranch}`)
  const pullRequest: GraphQlQueryResponseData = await octokit.graphql(createPullRequestMutation(), {
    repositoryId: draftRelease.id,
    baseRefName: branch,
    headRefName: releaseBranch,
    title: getPullRequestTitle(project, nextVersion),
    body: getPullRequestBody(project, nextVersion)
  })

  // const pull: Endpoints['POST /repos/{owner}/{repo}/pulls']['response'] = await octokit.rest.pulls.create({
  //   owner: github.context.repo.owner,
  //   repo: github.context.repo.repo,
  //   title: getPullRequestTitle(project, nextVersion),
  //   body: getPullRequestBody(project, nextVersion),
  //   head: releaseBranch,
  //   base: branch,
  //   draft: true
  // })
  core.debug(`Created Pull: ${JSON.stringify(pullRequest, null, 2)}`)
  //
  // const label: Endpoints['POST /repos/{owner}/{repo}/issues/{issue_number}/labels']['response'] = await octokit.rest.issues.addLabels({
  //   owner: github.context.repo.owner,
  //   repo: github.context.repo.repo,
  //   issue_number: pull.data.number,
  //   labels: ['release', project]
  // })
  // core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
}

// /**
//  * Create a draft PR for the release branch.
//  * @param octokit
//  * @param project
//  */
// export async function createPullRequest(octokit: Octokit, project: string): Promise<CreatedPullRequest> {
//   const releaseBranch: string = getReleaseBranchName(project)
//   const branch = github.context.ref.substring('refs/heads/'.length)
//
//   core.info(`Creating new PR for branch: ${releaseBranch}`)
//   const nextVersion = await getNextVersion(octokit, project, 'patch')
//   const pull: CreatePullRequestResponse = await octokit.rest.pulls.create({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     title: getPullRequestTitle(project, nextVersion),
//     body: getPullRequestBody(project, nextVersion),
//     head: releaseBranch,
//     base: branch,
//     draft: true
//   })
//   core.debug(`Created Pull: ${JSON.stringify(pull, null, 2)}`)
//
//   const label: AddLabelResponse = await octokit.rest.issues.addLabels({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     issue_number: pull.data.number,
//     labels: ['release', project]
//   })
//   core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
//
//   return pull.data
// }
//
// /**
//  * Update the PR for the release branch.
//  * @param octokit
//  * @param pull_number
//  * @param project
//  * @param nextVersion
//  * @param rebasing
//  */
// export async function updatePullRequest(octokit: Octokit, pull_number: number, project: string, nextVersion: string, rebasing: boolean = false): Promise<void> {
//   const releaseBranch: string = getReleaseBranchName(project)
//   const branch = github.context.ref.substring('refs/heads/'.length)
//
//   core.info(`Updating existing PR for branch: ${releaseBranch}`)
//   const pull = await octokit.rest.pulls.update({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     pull_number: pull_number,
//     title: getPullRequestTitle(project, nextVersion),
//     body: getPullRequestBody(project, nextVersion, rebasing),
//     head: releaseBranch,
//     base: branch,
//     draft: true
//   })
//   core.debug(`Updated Pull: ${JSON.stringify(pull, null, 2)}`)
//
//   const label: AddLabelResponse = await octokit.rest.issues.addLabels({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     issue_number: pull_number,
//     labels: ['release', project]
//   })
//   core.debug(`Added Label: ${JSON.stringify(label, null, 2)}`)
// }
//
// /**
//  * List all tags for the project.
//  * @param octokit
//  * @param project
//  */
// export async function listTags(octokit: Octokit, project: string): Promise<Tag[]> {
//   const tags: ListTagsResponse = await octokit.rest.git.listMatchingRefs({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     ref: `tags/${project}`
//   })
//   return tags.data
// }
//
// /**
//  * Add a reaction to a comment.
//  * @param octokit
//  * @param comment_number
//  * @param reaction
//  */
// export async function addReaction(octokit: Octokit, comment_number: number, reaction: Reaction): Promise<void> {
//   const response: CreateReactionResponse = await octokit.rest.reactions.createForIssueComment({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     comment_id: comment_number,
//     content: reaction
//   })
//   core.debug(`Added Reaction: ${JSON.stringify(response, null, 2)}`)
// }
//
// /**
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
//
// /**
//  * List all comments on a PR.
//  * @param octokit
//  * @param pull_number
//  */
// export async function listComments(octokit: Octokit, pull_number: number): Promise<Comment[]> {
//   const comments: ListCommentsResponse = await octokit.rest.issues.listComments({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     issue_number: pull_number
//   })
//   core.debug(`List Comments: ${JSON.stringify(comments, null, 2)}`)
//   return comments.data
// }
//
// /**
//  * Add a comment to a PR.
//  * @param octokit
//  * @param pull_number
//  * @param body
//  */
// export async function createComment(octokit: Octokit, pull_number: number, body: string): Promise<Comment> {
//   const response: CreateCommentResponse = await octokit.rest.issues.createComment({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     issue_number: pull_number,
//     body: body
//   })
//   core.debug(`Added Comment: ${JSON.stringify(response, null, 2)}`)
//   return response.data
// }
//
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
