const path = require('path')
const { promises: fs } = require('fs')
const workerpool = require('workerpool')
const globby = require('globby')
const { Print, chalk } = require('@ianwalter/print')
const { oneLine } = require('common-tags')
const pSeries = require('p-series')
const { SnapshotState } = require('jest-snapshot')
const merge = require('@ianwalter/merge')
const callsites = require('callsites')
const shuffle = require('array-shuffle')

const defaultFiles = [
  '*tests.js',
  '*pptr.js',
  'tests/**/*tests.js',
  'tests/**/*pptr.js'
]

class FailFastError extends Error {
  constructor () {
    super(FailFastError.message)
  }
}
FailFastError.message = 'Run failed immediately since failFast option is set'

// A special instance for print used to just return the formatted string instead
// of printing to the console.
const fmt = new Print({ stream: false })

/**
 * Collects test names from test files and assigns them to a worker in a
 * worker pool that runs the associated test.
 */
async function run (config) {
  // Create the run context using the passed configuration and defaults.
  const context = {
    tests: defaultFiles,
    testContext: { hasRun: false, result: {}, timeout: config.timeout },
    // Initialize a count for each time a test file has been registered so that
    // the main thread can figure out when registration has completed and the
    // worker pool can be terminated.
    filesRegistered: 0,
    // Initialize a count for the total number of tests registered from all of
    // the test files.
    testsRegistered: 0,
    // Initialize collections for tests based on their result status.
    pass: [],
    fail: [],
    warn: [],
    skip: [],
    benchmarks: [],
    // Initialize a count for the total number of tests that have been run so
    // that the run can figure out when all tests have completed and the worker
    // pool can be terminated.
    testsRun: 0
  }

  // Destructure passed configuration and add it to testContext and context.
  const { updateSnapshot, tag = [], failed, ...restOfConfig } = config
  context.testContext.updateSnapshot = updateSnapshot ? 'all' : 'none'
  context.tags = Array.isArray(tag) ? tag : [tag]
  merge(context, restOfConfig)

  // Create the print instance with the given log level.
  const print = new Print(context.log)

  // Only run tests marked as failed in a JUnit file.
  if (failed) {
    const camaro = require('camaro')
    const file = typeof failed === 'string' ? failed : 'junit.xml'
    const xml = await fs.readFile(path.resolve(file), 'utf8')
    const template = { tests: ['//testcase[failure]', '@name'] }
    const { tests } = await camaro.transform(xml, template)
    print.write('\n')
    print.info(`Running failed tests in ${file}:`, '\n', tests.join('\n'))
    print.write('\n')
    context.failed = tests
  }

  // Add the absolute paths of the test files to the run context.
  context.files = shuffle(await globby(context.tests, { absolute: true }))
  print.debug('Run context', context)

  // Throw an error if there are no tests files found.
  if (context.files.length === 0) throw new Error('No test files found.')

  // Set the worker pool options. For now, it only sets the maximum amount of
  // workers used if the concurrency setting is set.
  const poolOptions = {
    ...(context.concurrency ? { maxWorkers: context.concurrency } : {})
  }

  // Set the path to the file used to create a worker.
  const workerPath = path.join(__dirname, 'worker.js')

  // For registering individual tests exported from test files:
  const registrationPool = workerpool.pool(workerPath, poolOptions)

  // For actually running the tests:
  const runPool = workerpool.pool(workerPath, poolOptions)

  // Terminate the worker pools when a user presses CTRL+C.
  process.on('SIGINT', function handleSignalInterruption () {
    context.err = new Error('RUN CANCELLED!')
    registrationPool.terminate(true)
    runPool.terminate(true)
  })

  // Sequentially run any before hooks specified by plugins.
  const toHookRun = require('./lib/toHookRun')
  if (context.plugins && context.plugins.length) {
    await pSeries(context.plugins.map(toHookRun('before', context)))
  }

  function printResult (test, benchmarks) {
    let testName = test.name

    // Determine if the benchmark has multiple results so that they can be
    // displayed in a way that makes it easier to compare them.
    const hasMultipleResults = test.results && test.results.length > 1

    // TODO: comment.
    let perf = ''
    if (test.results && !hasMultipleResults) {
      testName = testName.padEnd(benchmarks.pad.name + 2)
      perf = test.results[0].perf.padStart(benchmarks.pad.perf)
    }

    // TODO: comment.
    print.write('\n')

    // TODO: comment.
    const msg = `${context.testsRun + 1}. ${testName}`
    if (test.results) {
      print.log('⏱️', chalk.white.bold(msg), perf)
    } else if (test.result.status === 'skip') {
      print.log('🛌', msg, test.result.only ? chalk.dim('(via only)') : '')
    } else if (test.result.status === 'pass') {
      print.success(msg)
    } else if (test.result.status === 'warn') {
      print.warn(msg)
    } else if (test.result.status === 'fail') {
      print.error(msg)
    }

    // Increment the test run count now that the test has completed.
    context.testsRun++

    // Create a string of spaces to indent test output appropriately.
    const pad = ''.padEnd((context.testsRun * 100).toString().length)

    // Print the extra test information if in verbose mode.
    if (context.verbose) {
      // Log the test callsite and test duration if in verbose mode.
      const m = chalk.bold(`${pad}${test.file.relativePath}:${test.lineNumber}`)
      print.log(m)
      if (test.result && test.result.duration) {
        print.log(chalk.dim(`${pad}in`, test.result.duration))
      }
    }

    // Print the reason for the test failure.
    if (test.result && test.result.err) {
      // Print the error separately, but inline with, the test failure.
      const lines = fmt.error(test.result.err).substring(4).split('\n')
      print.log(lines.map(l => pad + l.trimStart()).join('\n').trimEnd())
    } else if (hasMultipleResults) {
      for (const [index, b] of test.results.entries()) {
        // Format the name of the result based on the pad created from all
        // result names.
        const resultName = pad + b.name.padEnd(benchmarks.pad.name + 2)

        // Determine the result percentage as compared to the fastest result.
        const { hz } = test.results[0].result
        const pct = (b.result.hz / hz * 100).toFixed() + '%'

        // Print the result based on it's relative performance.
        const resultVal = `${b.perf.padStart(benchmarks.pad.perf)} ${pct}`
        if (index === 0) {
          print.log(chalk.green(resultName), chalk.green(resultVal))
        } else if (index + 1 === test.results.length) {
          print.log(chalk.red(resultName), chalk.red(resultVal))
        } else {
          print.log(chalk.yellow(resultName), chalk.yellow(resultVal))
        }
      }
    }
  }

  let hasTestRegistered = false
  try {
    // For each test file found, pass the filename to a registration pool
    // worker so that the tests within it can be collected and given to a
    // run pool worker to be run.
    await Promise.all(context.files.map(async filePath => {
      // Create the file context to contain information on the test file.
      const relativePath = path.relative(process.cwd(), filePath)
      const file = { path: filePath, relativePath }

      // Construct the path to the snapshot file.
      const snapshotsDir = path.join(path.dirname(filePath), 'snapshots')
      const snapshotFilename = `${path.basename(filePath)}.snap`
      file.snapshotPath = path.join(snapshotsDir, snapshotFilename)

      // Perform registration on the test file to collect the tests that need
      // to be run.
      merge(file, await registrationPool.exec('register', [file, context]))

      // Increment the registration count now that registration has completed
      // for the current test file.
      context.filesRegistered++

      // Terminate the registration pool if all the test files have been
      // registered.
      if (context.filesRegistered === context.files.length) {
        const numberOfTests = context.testsRegistered + file.tests.length
        print.debug('Number of tests:', numberOfTests)
        registrationPool.terminate()
          .then(() => print.debug('Registration pool terminated'))
      }

      // Add the number of tests returned by test registration to the running
      // total of all tests that need to be run.
      context.testsRegistered += file.tests.filter(t => !t.bench).length

      // If there are tests registered and not just benchmarks, print the tests
      // title / separator.
      if (!hasTestRegistered && context.testsRegistered) {
        hasTestRegistered = true
        print.write('\n')
        print.write(chalk.dim.bold('TESTS –––––––––––––––––––––––––––––––––––'))
      }

      // Determine if any of the tests in the test file have the .only
      // modifier so that tests can be excluded from being run.
      const hasOnly = Object.values(file.tests).some(test => test.only)

      // Get the snapshot state for the current test file.
      const options = { updateSnapshot: context.testContext.updateSnapshot }
      const snapshotState = new SnapshotState(file.snapshotPath, options)

      // Iterate through all tests in the test file.
      await Promise.all(shuffle(file.tests).map(async test => {
        // TODO: comment
        test.result = { only: hasOnly && !test.only, status: 'fail' }

        try {
          // Mark all tests as having been checked for snapshot changes so
          // that tests that have been removed can have their associated
          // snapshots removed as well when the snapshots are checked for this
          // test file.
          snapshotState.markSnapshotsAsCheckedForTest(test.name)

          if (test.skip || test.result.only) {
            // TODO: comment
            test.result.status = 'skip'
          } else if (!context.failed || context.failed.includes(test.name)) {
            // Send the test to a worker in the run pool to be run.
            test.result = await runPool
              .exec('test', [file, test, context])
              // TODO:
              // .timeout(context.timeout)

            // Update the snapshot state with the snapshot data received from
            // the worker.
            if (test.result && (test.result.added || test.result.updated)) {
              snapshotState._dirty = true
              snapshotState._counters = new Map(test.result.counters)
              Object.assign(snapshotState._snapshotData, test.result.snapshots)
              snapshotState.added += test.result.added
              snapshotState.updated += test.result.updated
            }

            // TODO: comment
            test.result.status = 'pass'
          }
        } catch (err) {
          // Ignore 'Worker terminated' errors since there is already output
          // when a run is cancelled.
          const workerpoolErrors = ['Worker terminated', 'Pool terminated']
          if (workerpoolErrors.includes(err.message)) return

          // TODO: comment
          merge(test.result, { status: test.warn ? 'warn' : 'fail', err })
        } finally {
          if (test.bench) {
            // Collect any tests that are marked as benchmarks.
            context.benchmarks.push({ ...test, file })
          } else {
            // Collect tests based on their result status.
            context[test.result.status].push(test)

            // TODO: comment
            printResult({ ...test, file })
          }
        }

        // If the failFast option is set, throw an error so that the test run is
        // immediately failed.
        const [err] = context.fail
        if (err && context.failFast) throw new FailFastError()
      }))

      // The snapshot tests that weren't checked are obsolete and can be
      // removed from the snapshot file.
      if (snapshotState.getUncheckedCount()) snapshotState.removeUncheckedKeys()

      // Save the snapshot changes.
      snapshotState.save()
    }))
  } catch (err) {
    // Add the fatal error to the context so the CLI can fail the run.
    context.err = err
  }

  // Sequentially run any after hooks specified by plugins.
  if (context.plugins && context.plugins.length) {
    await pSeries(context.plugins.map(toHookRun('after', context)))
  }

  // Terminate the run pool now that all tests have been run.
  runPool
    .terminate()
    .then(() => print.debug('Run pool terminated', runPool.stats()))

  // If there was an error thrown outside of the test functions (e.g.
  // requiring a module that wasn't found) then output a fatal error.
  if (context.err) {
    print.fatal(context.err)
    if (context.err instanceof FailFastError) {
      print.write('\n')
    } else {
      process.exit(1)
    }
  }

  // Log the results of running the tests.
  if (context.testsRun) {
    // Add a blank line between the test output and result summary so it's
    // easier to spot.
    print.write('\n')

    print.info(
      chalk.green.bold(`${context.pass.length} passed.`),
      chalk.red.bold(`${context.fail.length} failed.`),
      chalk.yellow.bold(`${context.warn.length} warned.`),
      chalk.white.bold(`${context.skip.length} skipped.`)
    )

    // Add blank line after the test result summary.
    print.write('\n')
  }

  if (context.benchmarks.length) {
    // If there were non-benchmark tests run, print a separator before printing
    // the benchmark results.
    if (hasTestRegistered) {
      print.write('\n')
      print.write(chalk.dim.bold('BENCHMARKS ––––––––––––––––––––––––––––––––'))
    }

    // Reduce the individual benchmarks into groups of related benchmarks.
    const benchmarks = context.benchmarks.reduce(
      ({ suites, pad, ...acc }, b) => {
        // If an error was thrown during the benchmark, print it.
        if (b.result.err || b.result.status === 'skip') {
          printResult(b)
          return { suites, pad, ...acc }
        }

        // Create a suite so that benchmarks with multiple results can be
        // compared.
        const { bench: name, file, lineNumber, result, results = [] } = b
        const suite = suites[name] || { name, results, pad, file, lineNumber }

        // Format the performance in terms of operations per second.
        // FIXME: get locale from environment variable?
        b.perf = result.hz.toLocaleString('en-US') + ' ops/s'

        // Create a pad between the suite / result names and their values.
        pad.name = b.name.length > pad.name ? b.name.length : pad.name

        // Create a pad so that performance values are "right-aligned".
        pad.perf = b.perf.length > pad.perf ? b.perf.length : pad.perf

        // Add the result to the suite.
        suite.results.push(b)

        // Sort the results by highest performance.
        suite.results.sort((a, b) => b.result.hz - a.result.hz)

        return { suites: { ...suites, [b.bench]: suite }, pad }
      },
      { suites: {}, pad: { name: 0, perf: 0 } }
    )

    // TODO: comment
    Object.values(benchmarks.suites).forEach(s => printResult(s, benchmarks))

    // Add blank line after the benchmark results.
    print.write('\n')
  }

  // If configured, generate a junit XML report file based on the test results.
  if (config.junit) {
    const junitBuilder = require('junit-report-builder')

    // Determine the junit report file path.
    const junit = typeof config.junit === 'string' ? config.junit : 'junit.xml'

    // Group tests by test file so that the test file relative path can be used
    // as the suite name.
    const { pass, fail, warn, skip } = context
    const files = [...pass, ...fail, ...warn, ...skip].reduce((acc, test) => {
      if (acc[test.file]) {
        acc[test.file].push(test)
      } else {
        acc[test.file] = [test]
      }
      return acc
    }, {})

    // Create a test for each test file and add the containing tests to the
    // suite as test cases.
    for (const [file, tests] of Object.entries(files)) {
      const suite = junitBuilder.testSuite().name(file)
      for (const test of tests) {
        const testCase = suite.testCase().name(test.name)
        if (test.skip || (test.err && test.warn)) {
          testCase.skipped()
        } else if (test.err) {
          testCase.failure(test.err)
        }
      }
    }

    // Write the junit report file to the filesystem.
    junitBuilder.writeTo(junit)
  }

  return context
}

function extractStringFromStrings (strings) {
  return oneLine(Array.isArray(strings) ? strings.join('') : strings)
}

class Tag {
  constructor (strings) {
    this.name = extractStringFromStrings(strings)
  }
}

const tag = strings => new Tag(strings)

class Bench extends Tag {}

const bench = strings => new Bench(strings)

function toUnit (unit, value) {
  if (Array.isArray(value)) {
    return value.reduce(toUnit, unit)
  } else if (value instanceof Bench) {
    unit.bench = value.name || unit.name
  } else if (value instanceof Tag) {
    unit.tags.push(value.name)
  } else if (typeof value === 'object') {
    return Object.assign(unit, value)
  } else if (typeof value === 'function') {
    unit.fn = value
  }
  return unit
}

function test (strings, ...rest) {
  // Prevent caching of this module so module.parent is always accurate. Thanks
  // sindresorhus/meow.
  delete require.cache[__filename]

  const unit = rest.reduce(toUnit, {
    name: extractStringFromStrings(strings),
    tags: [],
    state: {}
  })

  // Add the test line number to the object so it can be shown in verbose
  // mode.
  unit.lineNumber = (unit.callsites || callsites())[1].getLineNumber()

  module.parent.exports[unit.name] = unit
}

test.skip = function skip (strings, ...rest) {
  test(strings, { skip: true, callsites: callsites() }, ...rest)
}

test.only = function only (strings, ...rest) {
  test(strings, { only: true, callsites: callsites() }, ...rest)
}

test.warn = function warn (strings, ...rest) {
  test(strings, { warn: true, callsites: callsites() }, ...rest)
}

module.exports = { run, test, tag, Tag, bench, Bench, FailFastError }
