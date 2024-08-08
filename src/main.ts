import * as core from '@actions/core'
import * as github from '@actions/github'
import { graphql, type GraphQlQueryResponseData } from '@octokit/graphql'
import { IssueCommentEvent, PushEvent } from '@octokit/webhooks-types'
import * as git from './git-helper'
import * as githubapi from './github-helper'
import * as versions from './version-helper'
import { Commands, getNextVersion, setVersion, Version } from './github-helper'
import { GitHub } from '@actions/github/lib/utils'
import { note, caution } from './markdown'

enum Events {
  Push = 'push',
  IssueComment = 'issue_comment'
}

const DAYS_OLD = 30
const projects = ['core', 'grid']

/**
 * Get the number of days between two dates.
 * @param d1
 * @param d2
 */
function daysBetween(d1: Date, d2: Date) {
  const diff = Math.abs(d1.getTime() - d2.getTime())
  return diff / (1000 * 60 * 60 * 24)
}

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token')
    const octokit = github.getOctokit(token)

    const { repository }: GraphQlQueryResponseData = await graphql(
      `
        {
          repository(owner: "octokit", name: "graphql.js") {
            issues(last: 3) {
              edges {
                node {
                  title
                }
              }
            }
          }
        }
      `,
      {
        headers: {
          authorization: `token secret123`
        }
      }
    )
    core.info(`Repository: ${JSON.stringify(repository, null, 2)}`)

    core.debug(`Github Context: ${JSON.stringify(github.context, null, 2)}`)

    /**
     * Handle commits being pushed to the branch we are monitoring
     */
    if (github.context.eventName === Events.Push) {
      await pushEvent(octokit)
    }

    /**
     * Handle PRs being commented on
     */
    if (github.context.eventName === Events.IssueComment) {
      await issueCommentEvent(octokit)
    }
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

/**
 * Handles the push event.
 * @param octokit
 */
async function pushEvent(octokit: InstanceType<typeof GitHub>): Promise<void> {
  const pushPayload = github.context.payload as PushEvent

  core.startGroup('Files Changed in Push')
  const files = await githubapi.listPushCommitFiles(octokit, pushPayload)
  files.forEach(file => core.info(file))
  core.endGroup()

  core.startGroup('Projects of Relevance:')
  const projectsOfRelevance = await githubapi.listProjectsOfRelevance(files)
  projectsOfRelevance.forEach(projectOfRelevance => core.info(projectOfRelevance))
  core.endGroup()

  for (const project of projectsOfRelevance) {
    core.startGroup('Checking for Branch')
    const nextVersion = await getNextVersion(octokit, project, 'patch')
    const releaseBranch = `releasebot-${project}`
    const releaseBranchPR = await githubapi.findPullRequest(octokit, project)
    const releaseBranchExists = await githubapi.releaseBranchExists(octokit, project)
    if (!releaseBranchExists) {
      await githubapi.createReleaseBranch(octokit, project)
      await githubapi.setVersion(octokit, project, releaseBranch, nextVersion)
    } else {
      if (releaseBranchPR) {
        const daysOld = daysBetween(new Date(releaseBranchPR.created_at), new Date())
        if (daysOld <= DAYS_OLD) {
          core.info('Release branch already exists. Rebasing...')
          try {
            // Update PR to indicate rebasing
            await githubapi.updatePullRequest(octokit, releaseBranchPR.number, project, nextVersion, true)
            try {
              const token = core.getInput('token')
              await git.init(token)
              await git.clone()
              await git.fetchBranch(releaseBranch)
              await git.switchBranch(releaseBranch)
              await git.fetchUnshallow()
              await git.rebaseBranch('origin/main')
              await git.push(releaseBranch, true)
            } catch (error) {
              await githubapi.addOrUpdateComment(octokit, releaseBranchPR.number, caution('Failed to rebase the branch. Please either manually rebase it or use the `recreate` command.'))
              if (error instanceof Error) core.setFailed(error.message)
            }
          } finally {
            // Update PR to indicate rebasing is complete
            await githubapi.updatePullRequest(octokit, releaseBranchPR.number, project, nextVersion)
          }
        } else {
          await githubapi.addOrUpdateComment(octokit, releaseBranchPR.number, note(`Branch is now older than the ${DAYS_OLD} day limit. Please manually \`recreate\` and merge it when ready.`))
          core.warning(`Release branch is ${daysOld} days old. Ignoring...`)
        }
      }
    }
    core.endGroup()

    if (!releaseBranchPR) {
      core.startGroup('Checking for Pull Request')
      await githubapi.createPullRequest(octokit, project)
      core.endGroup()
    }
  }
}

/**
 * Handles the issue comment event.
 * @param octokit
 */
async function issueCommentEvent(octokit: InstanceType<typeof GitHub>): Promise<void> {
  const commentPayload = github.context.payload as IssueCommentEvent

  const project = githubapi.extractProjectNameFromPR(commentPayload.issue.body!)
  if (project) {
    core.info(`Issue comment found for: ${project}`)
    if (commentPayload.comment.body.startsWith(Commands.SetVersion)) {
      await issueCommentEventSetVersion(octokit, project, commentPayload)
    }

    if (commentPayload.comment.body.startsWith(Commands.Rebase)) {
      await issueCommentEventRebase(octokit, project, commentPayload)
    }

    if (commentPayload.comment.body.startsWith(Commands.Recreate)) {
      await issueCommentEventRecreate(octokit, project, commentPayload)
    }
  } else {
    core.warning('No issue for comment found')
  }
}

/**
 * Handles the issue comment event for setting the version.
 * @param octokit
 * @param project
 * @param comment
 */
async function issueCommentEventSetVersion(octokit: InstanceType<typeof GitHub>, project: string, comment: IssueCommentEvent): Promise<void> {
  const versionType = comment.comment.body.split(' ')[2]
  core.debug(`Version Type: ${versionType}`)
  if (versions.isValidSemverVersionType(versionType)) {
    const version = await githubapi.getNextVersion(octokit, 'core', versionType as Version)
    const releaseBranch = `releasebot-${project}`

    core.startGroup('Setting new version')
    await githubapi.addReaction(octokit, comment.comment.id, '+1')
    await githubapi.setVersion(octokit, project, releaseBranch, version)
    await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
    core.endGroup()
  } else {
    core.setFailed(`Invalid version type: ${versionType}`)
  }
}

/**
 * Handles the issue comment event for rebasing the branch.
 * @param octokit
 * @param project
 * @param comment
 */
async function issueCommentEventRebase(octokit: InstanceType<typeof GitHub>, project: string, comment: IssueCommentEvent): Promise<void> {
  core.startGroup('Rebasing')
  const version = await getNextVersion(octokit, project, 'patch')
  const releaseBranch = `releasebot-${project}`

  await githubapi.addReaction(octokit, comment.comment.id, '+1')
  await githubapi.updatePullRequest(octokit, comment.issue.number, project, version, true)

  try {
    const token = core.getInput('token')
    await git.init(token)
    await git.clone()
    await git.fetchBranch(releaseBranch)
    await git.switchBranch(releaseBranch)
    await git.fetchUnshallow()
    await git.rebaseBranch('origin/main')
    await git.push(releaseBranch, true)
    await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
  } catch (error) {
    await githubapi.createComment(octokit, comment.issue.number, caution('Failed to rebase the branch. Please either manually rebase it or use the `recreate` command.'))
    if (error instanceof Error) core.setFailed(error.message)
  }

  core.endGroup()
}

/**
 * Handles the issue comment event for recreating the branch.
 * @param octokit
 * @param project
 * @param comment
 */
async function issueCommentEventRecreate(octokit: InstanceType<typeof GitHub>, project: string, comment: IssueCommentEvent): Promise<void> {
  core.startGroup('Recreating Branch')
  const version = await getNextVersion(octokit, project, 'patch')
  await githubapi.addReaction(octokit, comment.comment.id, '+1')
  await githubapi.recreateReleaseBranch(octokit, project)
  await githubapi.setVersion(octokit, project, `releasebot-core`, version)
  await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
  core.endGroup()
}
