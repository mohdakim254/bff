const { worker } = require('workerpool')
const pSeries = require('p-series')
const { Print, chalk } = require('@ianwalter/print')
const buildTest = require('./lib/buildTest')

let threadId = process.pid
try {
  const workerThreads = require('worker_threads')
  threadId = workerThreads.threadId
} catch (err) {
  // Ignore error.
}

worker({
  async register (file, context) {
    // Create the Print instance based on the log level set in the context
    // received from the main thread.
    const print = new Print({ level: context.logLevel })

    // Print a debug statement for this registration action with the relative
    // path of the test file that's having it's tests registered.
    const relativePath = chalk.dim(file.relativePath)
    print.debug(`Registration worker ${threadId}`, relativePath)

    // Sequentially run any registration hooks specified by plugins.
    const toHookRun = require('./lib/toHookRun')
    if (context.plugins && context.plugins.length) {
      await pSeries(
        context.plugins.map(toHookRun('registration', file, context))
      )
    }

    // If the map of tests in the current test file hasn't been added to the
    // context, require the test file and use it's exports object as the test
    // map.
    if (!context.testMap) {
      context.testMap = require(file.path)
    }
    console.log(context.testMap)

    // Add a list of tests from the test file that are intended to be run to
    // the file context.
    const { tags, match } = context
    const tagsMatch = test => {
      if (['some', 'every'].includes(match)) {
        return tags[match](tag => test.tags.includes(tag))
      }
      throw new Error(`match value must be 'some' or 'every', not '${match}'`)
    }
    file.tests = Object.entries(context.testMap).reduce(
      (acc, [name, test]) => {
        if (Array.isArray(test)) {
          // TODO: move this right after testMap generated.
          const key = name
          if (typeof test[0] === 'string') {
            name = test.shift()
          }

          const testFn = test.pop()
          const tags = [testFn]
          if (Array.isArray(test[0])) {
            tags.unshift(tags)
          }

          const options = {
            key,
            skip: testFn.name === 'skip',
            only: testFn.name === 'only',
            warn: testFn.name === 'warn'
          }

          test = buildTest(name, options, tags)
          console.log('test', test)
        } else if (typeof test !== 'object') {
          // TODO: add a debug statement describing how the test is ignored
          // because it is not an Array or Object.
          return print.debug('TODO')
        }

        // TODO: Move logic to context map build test logic.
        const testShouldRun = !tags.length || (tags.length && tagsMatch(test))
        return testShouldRun ? acc.concat([test]) : acc
      },
      []
    )

    // TODO: make this plugin hook and move above tag filtering
    // If an augmentTests method has been added to the context by a plugin, call
    // it with the list of tests so that the plugin can alter them if necessary.
    if (context.augmentTests) {
      file.tests = context.augmentTests(file.tests)
    }

    // Return the file context with the the list of registered tests.
    return file
  },
  async test (file, test, context) {
    const Subpub = require('@ianwalter/subpub')
    const merge = require('@ianwalter/merge')
    const createTimer = require('@ianwalter/timer')
    const toHookRun = require('./lib/toHookRun')

    // Create the Print instance based on the log level set in the context
    // received from the main thread.
    const print = new Print({ level: context.logLevel })

    // Print a debug statement for this test action with the test name and
    // relative path of the test file it belongs to.
    const relativePath = chalk.dim(file.relativePath)
    print.debug(`Test worker ${threadId}`, chalk.cyan(test.name), relativePath)

    // Add the file and test data to the testContext.
    merge(context.testContext, file, test)

    // Add a Subpub instance to the testContext so it can listen for the 'done'
    // event.
    context.testContext.sp = new Subpub()

    try {
      if (context.plugins && context.plugins.length) {
        // Sequentially run any beforeEach hooks specified by plugins.
        await pSeries(
          context.plugins.map(toHookRun('beforeEach', file, context))
        )

        // If the verbose option is set, start a timer for the test.
        if (context.verbose) {
          context.timer = createTimer()
        }

        // Sequentially run any runTest hooks specified by plugins.
        await pSeries(context.plugins.map(toHookRun('runTest', file, context)))
      }

      if (!context.testContext.hasRun) {
        // If the verbose option is set, start a timer for the test.
        if (context.verbose) {
          context.timer = createTimer()
        }

        // Enhance the context passed to the test function with testing
        // utilities.
        const enhanceTestContext = require('./lib/enhanceTestContext')
        enhanceTestContext(context.testContext)
        context.testContext.print = print

        // Load the test file and extract the relevant test function.
        const { fn } = require(file.path)[test.key]

        // Run the test!
        const runTest = require('./lib/runTest')
        await runTest(context.testContext, fn)
        context.testContext.hasRun = true
      }

      // If there was a timer started for the test, stop the timer, get the
      // timer's duration, and add it to the test result.
      if (context.timer) {
        const { duration } = context.timer.stop(2)
        print.debug('Test duration', duration)
        context.testContext.result.duration = duration
      }
    } finally {
      // Sequentially run any afterEach hooks specified by plugins.
      if (context.plugins && context.plugins.length) {
        await pSeries(
          context.plugins.map(toHookRun('afterEach', file, context))
        )
      }
    }

    // Return the test result to the main thread.
    if (context.testContext.result.failed) {
      throw context.testContext.result.failed
    }
    return context.testContext.result
  }
})
