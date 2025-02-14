// test
const { execSync, spawn, exec } = require('child_process');
const { existsSync } = require('fs');
const { EOL } = require('os');
const path = require('path');
const gitLog = require('git-log-parser')
const through2 = require('through2')
const core = require('@actions/core');

// Change working directory if user defined PACKAGEJSON_DIR
if (process.env.PACKAGEJSON_DIR) {
  process.env.GITHUB_WORKSPACE = `${process.env.GITHUB_WORKSPACE}/${process.env.PACKAGEJSON_DIR}`
  process.chdir(process.env.GITHUB_WORKSPACE)
}

const executeCmd = async (cmd) => {
  console.log('>', cmd)
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }
      if (stderr) {
        console.error(stderr)
      }

      resolve(stdout.replace('\n', ''))
    })
  })
}

// https://stackoverflow.com/questions/12082981/get-all-git-commits-since-last-tag
const getLastTagName = async () => { // string
  await executeCmd('git fetch')
  await executeCmd('git fetch --tags')
  await executeCmd('git pull --all')
  await executeCmd('git pull --tags')
  console.log(await executeCmd('git status'))
  return executeCmd('git tag --sort=committerdate | tail -1')
}

const getCommitsSinceLastTag = async (lastTagName) => {
  console.log('Last Tag name:', lastTagName)

  return new Promise((resolve) => {
    const commits = []
    gitLog
      .parse({
        _: `${lastTagName}..@`
      })
      .pipe(through2.obj(function (chunk, enc, callback) {
        this.push(chunk)
        callback()
      }))
      .on('data', (data) => {
        commits.push(data)
      })
      .on('end', () => {
        // map the commits subject field to -> message, for it to be compatible with the rest of the code
        resolve(commits.map((commit) => ({
          ...commit,
          message: commit.subject
        })))
      })
  })
}

const workspace = process.env.GITHUB_WORKSPACE;

(async () => {
  const pkg = getPackageJson();
  const event = process.env.GITHUB_EVENT_PATH ? require(process.env.GITHUB_EVENT_PATH) : {};

  // const event = tools.context.payload;
  // if (!event.commits) {
  //   console.log("Couldn't find any commits in this event, incrementing patch version...");
  // }
  const compareTag = process.env['INPUT_COMMITS-COMPARISON'] === 'last_tags' ? await getLastTagName() : process.env['INPUT_COMMITS-COMPARISON'];
  const commits = await getCommitsSinceLastTag(compareTag)
  if (commits == null || commits.length === 0) {
    exitNeutral('There were no commits to process!')
    return
  }

  const tagPrefix = process.env['INPUT_TAG-PREFIX'] || ''
  const messages = commits.map((commit) => commit.message + '\n' + commit.body)

  const commitMessage = process.env['INPUT_COMMIT-MESSAGE'] || 'ci: version bump to {{version}}';
  console.log('commit messages:', messages);

  const bumpPolicy = process.env['INPUT_BUMP-POLICY'] || 'all';
  const commitMessageRegex = new RegExp(commitMessage.replace(/{{version}}/g, `${tagPrefix}\\d+\\.\\d+\\.\\d+`), 'ig');

  let isVersionBump = false;

  if (bumpPolicy === 'all') {
    isVersionBump = messages.find((message) => commitMessageRegex.test(message)) !== undefined;
  } else if (bumpPolicy === 'last-commit') {
    isVersionBump = messages.length > 0 && commitMessageRegex.test(messages[messages.length - 1]);
  } else if (bumpPolicy === 'ignore') {
    console.log('Ignoring any version bumps in commits...');
  } else {
    console.warn(`Unknown bump policy: ${bumpPolicy}`);
  }

  if (isVersionBump) {
    exitSuccess('No action necessary because we found a previous bump!');
    return;
  }

  // input wordings for MAJOR, MINOR, PATCH, PRE-RELEASE
  const majorWords = process.env['INPUT_MAJOR-WORDING'].split(',')
  const minorWords = process.env['INPUT_MINOR-WORDING'].split(',')
  // patch is by default empty, and '' would always be true in the includes(''), thats why we handle it separately
  const patchWords = process.env['INPUT_PATCH-WORDING'] ? process.env['INPUT_PATCH-WORDING'].split(',') : null;
  const preReleaseWords = process.env['INPUT_RC-WORDING'] ? process.env['INPUT_RC-WORDING'].split(',') : null;

  console.log('config words:', { majorWords, minorWords, patchWords, preReleaseWords })

  // get default version bump
  let version = process.env.INPUT_DEFAULT
  let foundWord = null
  // get the pre-release prefix specified in action
  let preid = process.env.INPUT_PREID

  // case: if wording for MAJOR found
  if (
    messages.some(
      (message) => /^([a-zA-Z]+)(\(.+\))?(\!)\:/.test(message) || majorWords.some((word) => message.trim().startsWith(word))
    )
  ) {
    version = 'major'
  }
  // case: if wording for MINOR found
  else if (messages.some((message) => minorWords.some((word) => message.trim().startsWith(word)))) {
    version = 'minor'
  }
  // case: if wording for PATCH found
  else if (patchWords && messages.some((message) => patchWords.some((word) => message.trim().startsWith(word)))) {
    version = 'patch'
  }
  // case: if wording for PRE-RELEASE found
  else if (
    preReleaseWords &&
    messages.some((message) =>
      preReleaseWords.some((word) => {
        if (message.trim().startsWith(word)) {
          foundWord = word
          return true
        } else {
          return false
        }
      })
    )
  ) {
    preid = foundWord.split('-')[1]
    version = 'prerelease'
  }

  console.log('version action after first waterfall:', version)

  // case: if default=prerelease,
  // rc-wording is also set
  // and does not include any of rc-wording
  // then unset it and do not run
  if (
    version === 'prerelease' &&
    preReleaseWords &&
    !messages.some((message) => preReleaseWords.some((word) => message.includes(word)))
  ) {
    version = null
  }

  // case: if default=prerelease, but rc-wording is NOT set
  if (version === 'prerelease' && preid) {
    version = 'prerelease'
    version = `${version} --preid=${preid}`
  }

  // case: if nothing of the above matches
  if (version === null || version === undefined || version.trim().length === 0) {
    exitSuccess('No version keywords found, skipping bump.');
    return;
  }

  // handle when user opted-in to always create a pre-version
  else if (process.env['INPUT_ALWAYS-PRE-VERSION'] === 'true') {
    console.log('Detected ALWAYS-PRE-VERSION to be true. Will create a pre version...')
    if (!version.startsWith('pre')) {
      version = 'pre' + version
    }
    if (preid) {
      version = `${version} --preid=${preid}`
    }
  }

  console.log('version action after final decision:', version)

  // case: if user sets push to false, to skip pushing new tag/package.json
  const push = process.env['INPUT_PUSH'];
  if (push === 'false' || push === false) {
    exitSuccess('User requested to skip pushing new tag and package.json. Finished.');
    return;
  }

  // GIT logic
  try {
    const current = pkg.version.toString()
    // set git user
    await runInWorkspace('git', ['config', 'user.name', `"${process.env.GITHUB_USER || 'Automated Version Bump'}"`]);
    await runInWorkspace('git', [
      'config',
      'user.email',
      `"${process.env.GITHUB_EMAIL || 'gh-action-bump-version@users.noreply.github.com'}"`
    ])

    let currentBranch = /refs\/[a-zA-Z]+\/(.*)/.exec(process.env.GITHUB_REF)[1]
    let isPullRequest = false
    if (process.env.GITHUB_HEAD_REF) {
      // Comes from a pull request
      currentBranch = process.env.GITHUB_HEAD_REF
      isPullRequest = true
    }
    if (process.env['INPUT_TARGET-BRANCH']) {
      // We want to override the branch that we are pulling / pushing to
      currentBranch = process.env['INPUT_TARGET-BRANCH']
    }
    console.log('currentBranch:', currentBranch)
    // do it in the current checked out github branch (DETACHED HEAD)
    // important for further usage of the package.json version
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    let newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    newVersion = `${tagPrefix}${newVersion}`;
    if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
      await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
    }

    // now go to the actual branch to perform the same versioning
    if (isPullRequest) {
      // First fetch to get updated local version of branch
      await runInWorkspace('git', ['fetch']);
    }
    await runInWorkspace('git', ['checkout', currentBranch]);
    await runInWorkspace('npm', ['version', '--allow-same-version=true', '--git-tag-version=false', current]);
    console.log('current:', current, '/', 'version:', version);
    newVersion = execSync(`npm version --git-tag-version=false ${version}`).toString().trim().replace(/^v/, '');
    newVersion = `${tagPrefix}${newVersion}`;
    try {
      // to support "actions/checkout@v1"
      if (process.env['INPUT_SKIP-COMMIT'] !== 'true') {
        await runInWorkspace('git', ['commit', '-a', '-m', commitMessage.replace(/{{version}}/g, newVersion)]);
      }
    } catch (e) {
      console.warn(
        'git commit failed because you are using "actions/checkout@v2"; ' +
        'but that doesnt matter because you dont need that git commit, thats only for "actions/checkout@v1"'
      )
    }

    const remoteRepo = `https://${process.env.GITHUB_ACTOR}:${process.env.GITHUB_TOKEN}@github.com/${process.env.GITHUB_REPOSITORY}.git`
    if (process.env['INPUT_SKIP-TAG'] !== 'true') {
      await runInWorkspace('git', ['tag', newVersion]);
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo, '--follow-tags']);
        await runInWorkspace('git', ['push', remoteRepo, '--tags']);
      }
    } else {
      if (process.env['INPUT_SKIP-PUSH'] !== 'true') {
        await runInWorkspace('git', ['push', remoteRepo]);
      }
    }

    core.setOutput('newTag', newVersion);
    console.log(`New version: ${newVersion}`);
  } catch (e) {
    logError(e);
    exitFailure('Failed to bump version');
    return;
  }
  exitSuccess('Version bumped!');
})();

function getPackageJson() {
  const pathToPackage = path.join(workspace, 'package.json');
  if (!existsSync(pathToPackage)) throw new Error("package.json could not be found in your project's root.");
  return require(pathToPackage);
}

function exitSuccess(message) {
  console.info(`✔  success   ${message}`);
  process.exit(0);
}

function exitNeutral(message) {
  console.info(`o  neutral   ${message}`);
  process.exit(0);
}

function exitFailure(message) {
  logError(message);
  process.exit(1);
}

function logError(error) {
  console.error(`✖  fatal     ${error.stack || error}`);
}

function runInWorkspace(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: workspace });
    let isDone = false;
    const errorMessages = [];
    child.on('error', (error) => {
      if (!isDone) {
        isDone = true;
        reject(error);
      }
    });
    child.stderr.on('data', (chunk) => errorMessages.push(chunk));
    child.on('exit', (code) => {
      if (!isDone) {
        if (code === 0) {
          resolve();
        } else {
          reject(`${errorMessages.join('')}${EOL}${command} exited with code ${code}`);
        }
      }
    });
  });
  //return execa(command, args, { cwd: workspace });
}
