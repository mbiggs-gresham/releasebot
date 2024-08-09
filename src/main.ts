import * as core from '@actions/core'
import * as github from '@actions/github'
import { App, Octokit } from 'octokit'
import { type GraphQlQueryResponseData, GraphqlResponseError } from '@octokit/graphql'
import { IssueCommentEvent, PushEvent } from '@octokit/webhooks-types'
import * as git from './git-helper'
import * as githubapi from './github-helper'
import * as versions from './version-helper'
import { Commands, getNextVersion, KrytenbotDraftRelease, Reaction, Version } from './github-helper'
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
    const appId = core.getInput('app_id')
    const privateKey = core.getInput('private_key')

    const app: App = new App({ appId, privateKey })
    const { data: installation } = await app.octokit.rest.apps.getRepoInstallation({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo
    })

    const octokit: Octokit = await app.getInstallationOctokit(installation.id)

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
async function pushEvent(octokit: Octokit): Promise<void> {
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
    core.startGroup(`Checking for draft release info for '${project}'`)

    const releaseBranch = `krytenbot-${project}`
    const draftRelease = await githubapi.findDraftRelease(octokit, project)
    core.info(`Draft Release: ${JSON.stringify(draftRelease, null, 2)}`)

    core.info(`Calculating next version for '${project}'`)
    const nextVersion = githubapi.getNextVersion(draftRelease, 'patch')
    core.info(`Next version for '${project}': ${nextVersion}`)

    // Create new branch with new version or rebase the existing one
    core.info(`Checking for draft release branch for '${project}'`)
    if (!draftRelease.branches.branches.some(branch => branch.name === releaseBranch)) {
      core.info(`Creating draft release branch for '${project}'`)
      await githubapi.createDraftReleaseBranch(octokit, draftRelease, project)
      core.info(`Updating '${project}' version to ${nextVersion}`)
      await githubapi.setDraftReleaseBranchVersion(octokit, project, nextVersion, github.context.sha)
    }

    // Create pull request for new branch
    core.info(`Checking for pull request for '${project}'`)
    if (draftRelease.pullRequests.pullRequests.length === 0) {
      core.info(`Creating pull request for '${project}'`)
      const branch = github.context.ref.substring('refs/heads/'.length)
      await githubapi.createDraftReleasePullRequest(octokit, draftRelease, project, branch, nextVersion)
    } else {
      core.info(`Updating draft release branch for '${project}'`)
      await githubapi.updateDraftReleaseBranch(octokit, draftRelease, project)
    }

    core.endGroup()
  }
}

/**
 * Handles the issue comment event.
 * @param octokit
 */
async function issueCommentEvent(octokit: Octokit): Promise<void> {
  const comment = github.context.payload as IssueCommentEvent

  const project = githubapi.extractProjectNameFromPR(comment.issue.body!)
  if (project) {
    core.info(`Issue comment found for '${project}'`)

    const draftRelease = await githubapi.findDraftRelease(octokit, project)
    core.info(`Draft Release: ${JSON.stringify(draftRelease, null, 2)}`)

    if (comment.comment.body.startsWith(Commands.SetVersion)) {
      await issueCommentEventSetVersion(octokit, draftRelease, project, comment)
    }

    if (comment.comment.body.startsWith(Commands.Rebase)) {
      await issueCommentEventRebase(octokit, project, comment)
    }

    if (comment.comment.body.startsWith(Commands.Recreate)) {
      await issueCommentEventRecreate(octokit, project, comment)
    }
  } else {
    core.warning('No project for pull request found')
  }
}

/**
 * Handles the issue comment event for setting the version.
 * @param octokit
 * @param draftRelease
 * @param project
 * @param comment
 */
async function issueCommentEventSetVersion(octokit: Octokit, draftRelease: KrytenbotDraftRelease, project: string, comment: IssueCommentEvent): Promise<void> {
  const versionType = comment.comment.body.split(' ')[2]
  core.debug(`Version Type: ${versionType}`)
  if (versions.isValidSemverVersionType(versionType)) {
    core.info(`Calculating next version for '${project}'`)
    const nextVersion = githubapi.getNextVersion(draftRelease, versionType as Version)
    core.info(`Next version for '${project}': ${nextVersion}`)

    // const releaseBranch = `krytenbot-${project}`
    //
    // core.startGroup('Setting new version')
    // await githubapi.addReaction(octokit, comment.comment.id, '+1')
    // await githubapi.setVersion(octokit, project, releaseBranch, version)
    // await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
    // core.endGroup()

    core.info(`Updating '${project}' version to ${nextVersion}`)
    await githubapi.addCommentReaction(octokit, String(comment.comment.node_id), 'THUMBS_UP')
    await githubapi.setDraftReleaseBranchVersion(octokit, project, nextVersion, draftRelease.pullRequests.pullRequests[0].headRefOid)
    await githubapi.updatePullRequestTitle(octokit, draftRelease, project, nextVersion)
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
async function issueCommentEventRebase(octokit: Octokit, project: string, comment: IssueCommentEvent): Promise<void> {
  // core.startGroup('Rebasing')
  // const version = await getNextVersion(octokit, project, 'patch')
  // const releaseBranch = `krytenbot-${project}`
  //
  // await githubapi.addReaction(octokit, comment.comment.id, '+1')
  // await githubapi.updatePullRequest(octokit, comment.issue.number, project, version, true)
  //
  // try {
  //   const token = core.getInput('token')
  //   await git.init(token)
  //   await git.clone()
  //   await git.fetchBranch(releaseBranch)
  //   await git.switchBranch(releaseBranch)
  //   await git.fetchUnshallow()
  //   await git.rebaseBranch('origin/main')
  //   await git.push(releaseBranch, true)
  //   await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
  // } catch (error) {
  //   await githubapi.createComment(octokit, comment.issue.number, caution('Failed to rebase the branch. Please either manually rebase it or use the `recreate` command.'))
  //   if (error instanceof Error) core.setFailed(error.message)
  // }
  //
  // core.endGroup()
}

/**
 * Handles the issue comment event for recreating the branch.
 * @param octokit
 * @param project
 * @param comment
 */
async function issueCommentEventRecreate(octokit: Octokit, project: string, comment: IssueCommentEvent): Promise<void> {
  // core.startGroup('Recreating Branch')
  // const version = await getNextVersion(octokit, project, 'patch')
  // await githubapi.addReaction(octokit, comment.comment.id, '+1')
  // await githubapi.recreateReleaseBranch(octokit, project)
  // await githubapi.setVersion(octokit, project, `krytenbot-core`, version)
  // await githubapi.updatePullRequest(octokit, comment.issue.number, project, version)
  // core.endGroup()
}
