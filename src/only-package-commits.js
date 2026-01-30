import { identity, memoizeWith, pipeP } from 'ramda';
import pkgUp from 'pkg-up';
import readPkg from 'read-pkg';
import path from 'path';
import pLimit from 'p-limit';
import createDebug from 'debug';
import { getCommitFiles, getRoot } from './git-utils.js';
import { mapCommits } from './options-transforms.js';

const debug = createDebug('semantic-release:monorepo');
const memoizedGetCommitFiles = memoizeWith(identity, getCommitFiles);

/**
 * Get the normalized PACKAGE root path, relative to the git PROJECT root.
 */
const getPackagePath = async () => {
  const packagePath = await pkgUp();
  const gitRoot = await getRoot();

  return path.relative(gitRoot, path.resolve(packagePath, '..'));
};

const withFiles = async commits => {
  const limit = pLimit(Number(process.env.SRM_MAX_THREADS) || 500);
  return Promise.all(
    commits.map(commit =>
      limit(async () => {
        const files = await memoizedGetCommitFiles(commit.hash);
        return { ...commit, files };
      })
    )
  );
};

const onlyPackageCommits = async commits => {
  const packagePath = await getPackagePath();
  const { release } = await readPkg();
  const dependencies = release?.monorepo?.dependencies || [];
  debug('Filter commits by package path: "%s" and dependencies: %o', packagePath, dependencies);

  const commitsWithFiles = await withFiles(commits);
  const packageSegments = packagePath.split(path.sep);
  const dependencySegmentsList = dependencies.map(dep => dep.split(path.sep));

  return commitsWithFiles.filter(({ files, subject }) => {
    const isRelevantFile = file => {
      const fileSegments = path.normalize(file).split(path.sep);

      // Check if the file is in the current package
      const isInPackage = packageSegments.every(
        (seg, i) => seg === fileSegments[i]
      );

      // Check if the file is in any of the specified dependencies
      const isInDependencies = dependencySegmentsList.some(depSegments =>
        depSegments.every((seg, i) => seg === fileSegments[i])
      );

      return isInPackage || isInDependencies;
    };

    const packageFile = files.find(isRelevantFile);

    if (packageFile) {
      debug(
        'Including commit "%s" because it modified package file "%s".',
        subject,
        packageFile
      );
    }

    return !!packageFile;
  });
};

// Async version of Ramda's `tap`
const tapA = fn => async x => {
  await fn(x);
  return x;
};

const logFilteredCommitCount = logger => async ({ commits }) => {
  const { name } = await readPkg();

  logger.log(
    'Found %s commits for package %s since last release',
    commits.length,
    name
  );
};

const withOnlyPackageCommits = plugin => async (pluginConfig, config) => {
  const { logger } = config;

  return plugin(
    pluginConfig,
    await pipeP(
      mapCommits(onlyPackageCommits),
      tapA(logFilteredCommitCount(logger))
    )(config)
  );
};

export { withOnlyPackageCommits, onlyPackageCommits, withFiles };
