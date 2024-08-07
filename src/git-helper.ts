import { ExecOptions } from '@actions/exec'
import * as exec from '@actions/exec'
import * as core from '@actions/core'
import * as github from '@actions/github'
import * as io from '@actions/io'
import * as base64 from './base64-helper'

interface GitResult {
  stderr: string
  stdout: string
}

/**
 * Get the fetch URL for the repository.
 */
function getFetchUrl(): string {
  const encodedOwner = encodeURIComponent(github.context.repo.owner)
  const encodedName = encodeURIComponent(github.context.repo.repo)
  return `https://github.com/${encodedOwner}/${encodedName}`
}

/**
 * Execute a Git command with the given arguments.
 * @param args
 */
async function execGit(args: string[]): Promise<GitResult> {
  const stdout: string[] = []
  const stderr: string[] = []

  const options: ExecOptions = {
    listeners: {
      stdout: (data: Buffer) => {
        stdout.push(data.toString())
      },
      stderr: (data: Buffer) => {
        stderr.push(data.toString())
      }
    }
  }

  await exec.exec('git', args, options)
  return {
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n')
  }
}

/**
 * Display information about the Git installation.
 */
export async function displayInfo(): Promise<void> {
  const git = await io.which('git', true)
  const gitVersionOutput = await execGit(['--version'])
  const gitVersion = gitVersionOutput.stdout.match(/\d+\.\d+(\.\d+)?/)

  core.startGroup('Git Info')
  core.info(`Git Path: ${git}`)
  core.info(`Git Version: ${gitVersion}`)
  core.endGroup()
}

/**
 * Initialize and configure the repository.
 * @param token The security token to use for authentication.
 */
export async function init(token: string): Promise<void> {
  const basicCredential = base64.encode(`x-access-token:${token}`)

  const gitInitOutput = await execGit(['init', '--initial-branch', 'main'])
  core.info(`Git Init: ${gitInitOutput.stdout}`)

  await execGit(['remote', 'add', 'origin', getFetchUrl()])
  await execGit(['config', '--local', 'http.https://github.com/.extraheader', `AUTHORIZATION: Basic ${basicCredential}`])
  await execGit(['config', '--local', 'user.name', 'github-actions[bot]'])
  await execGit(['config', '--local', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])
}

/**
 * Clone the repository.
 */
export async function clone(): Promise<void> {
  const branch = github.context.ref.substring('refs/heads/'.length)
  const ref = `refs/remotes/origin/${branch}`

  const cloneOutput = await execGit(['fetch', '--no-tags', '--prune', '--depth', '1', 'origin', `+${github.context.sha}:${ref}`])
  core.info(`Git Fetch: ${cloneOutput.stdout}`)

  const checkoutOutput = await execGit(['checkout', '-b', branch, ref])
  core.info(`Git Branch: ${checkoutOutput.stdout}`)
}

/**
 * Fetch the specified remote branch.
 * @param name
 */
export async function fetchBranch(name: string): Promise<void> {
  const output = await execGit(['fetch', '--no-tags', '--prune', '--depth', '1', 'origin', name])
  core.info(`Git Fetch: ${output.stdout}`)
}

/**
 * Create a new branch.
 * @param name
 */
export async function createBranch(name: string): Promise<void> {
  const output = await execGit(['checkout', '-b', name])
  core.info(`Git Branch: ${output.stdout}`)
}

/**
 * Switch to the specified branch.
 * @param name
 */
export async function switchBranch(name: string): Promise<void> {
  const output = await execGit(['switch', name])
  core.info(`Git Switch: ${output.stdout}`)
}

/**
 * Push the branch to the remote repository.
 * @param name
 * @param force
 */
export async function push(name: string, force: boolean = false): Promise<void> {
  const output = await execGit(force ? ['push', '-f', '-u', 'origin', name] : ['push', '-u', 'origin', name])
  core.info(`Git Push: ${output.stdout}`)
}

/**
 * Rebase the release branch.
 * @param branch
 */
export async function rebaseBranch(branch: string): Promise<void> {
  const output = await execGit(['rebase', '--strategy-option', 'ours', `origin/${branch}`])
  core.info(`Git Rebase: ${output.stdout}`)
}
