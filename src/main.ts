import * as core from '@actions/core'
import * as github from '@actions/github'
import { IssueCommentEvent, PushEvent } from '@octokit/webhooks-types'
import * as git from './git-helper'
import * as githubapi from './github-helper'
import * as versions from './version-helper'
import { wait } from './wait'
import { Commands, getNextVersion, Version } from './github-helper'
import { GitHub } from '@actions/github/lib/utils'
import { fetchBranch } from './git-helper'

const projects = ['core', 'grid']

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token')
    const octokit = github.getOctokit(token)

    // await git.displayInfo()

    // core.startGroup('Git Fetch')
    // await git.init(token)
    // await git.clone()
    // await git.branch('test-branch')
    // await git.push('test-branch')
    // core.endGroup()

    core.debug(`Github Context: ${JSON.stringify(github.context, null, 2)}`)

    /**
     * Handle commits being pushed to the branch we are monitoring
     */
    if (github.context.eventName === 'push') {
      await pushEvent(octokit)
    }

    /**
     * Handle PRs being commented on
     */
    if (github.context.eventName === 'issue_comment') {
      await issueCommentEvent(octokit)
    }

    const ms: string = core.getInput('milliseconds')

    // Debug logs are only output if the `ACTIONS_STEP_DEBUG` secret is true
    core.debug(`Waiting ${ms} milliseconds ...`)

    // Log the current timestamp, wait, then log the new timestamp
    core.debug(new Date().toTimeString())
    await wait(parseInt(ms, 10))
    core.debug(new Date().toTimeString())

    // Set outputs for other workflow steps to use
    core.setOutput('time', new Date().toTimeString())
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

  core.startGroup('Files Changed of Relevance:')
  const filesOfRelevance = await githubapi.listPushCommitFilesOfRelevance(files)
  filesOfRelevance.forEach(fileOfRelevance => core.info(fileOfRelevance))
  core.endGroup()

  core.startGroup('Check for Pull Request')
  const releaseBranchExists = await githubapi.releaseBranchExists(octokit, 'core')
  if (!releaseBranchExists) {
    await githubapi.createReleaseBranch(octokit, 'core')
  } else {
    const token = core.getInput('token')
    await git.init(token)
    await git.clone()
    await git.fetchBranch('releasebot-core')
    await git.switchBranch('releasebot-core')
    await git.rebaseBranch('main')
  }

  const releaseBranchPR = await githubapi.findPullRequest(octokit, 'core')
  if (!releaseBranchPR) {
    await githubapi.createPullRequest(octokit, 'core')
  } else {
    const version = await getNextVersion(octokit, 'core', 'patch')
    await githubapi.updatePullRequest(octokit, releaseBranchPR.number, 'core', version)
  }
  core.endGroup()
}

/**
 * Handles the issue comment event.
 * @param octokit
 */
async function issueCommentEvent(octokit: InstanceType<typeof GitHub>): Promise<void> {
  const commentPayload = github.context.payload as IssueCommentEvent
  if (commentPayload.comment.body.startsWith(Commands.SetVersion)) {
    core.info('Issue Comment')

    const versionType = commentPayload.comment.body.split(' ')[2]
    core.debug(`Version Type: ${versionType}`)
    if (versions.isValidSemverVersionType(versionType)) {
      const version = await githubapi.getNextVersion(octokit, 'core', versionType as Version)
      const branch = github.context.ref.substring('refs/heads/'.length)

      core.startGroup('Setting new version')
      await githubapi.addReaction(octokit, commentPayload.comment.id, '+1')
      await githubapi.setVersion(octokit, 'core', 'releasebot-core', version)
      await githubapi.updatePullRequest(octokit, commentPayload.issue.number, 'core', version)
      core.endGroup()
    } else {
      core.setFailed(`Invalid version type: ${versionType}`)
    }
  }
}
