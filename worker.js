const { relative } = require('path')
const { worker } = require('workerpool')
const pSeries = require('p-series')
const pTimeout = require('p-timeout')
const { Print, chalk } = require('@ianwalter/print')
const { threadId } = require('worker_threads')

worker({
  async register (file, context) {
    const print = new Print({ level: context.logLevel })
    const relativePath = relative(process.cwd(), file.path)
    print.debug(`Registration worker ${threadId}`, chalk.gray(relativePath))
    const { toHookExec } = require('./lib')

    // Create the registration context with the list of tests that are intended
    // to be executed.
    const needsTag = context.tags && context.tags.length
    const toTests = (acc, [name, { skip, only, tags }]) => {
      const test = { key: name, name, skip, only, tags }
      if (!needsTag || (needsTag && tags.some(t => context.tags.includes(t)))) {
        acc.push(test)
      }
      return acc
    }
    const tests = Object.entries(require(file.path)).reduce(toTests, [])
    context.registrationContext = { file, tests }

    // Execute each function with the test names exported by the files
    // configured to be called during test registration.
    if (context.plugins && context.plugins.length) {
      await pSeries(
        context.plugins.map(toHookExec('registration', context))
      )
    }

    return context.registrationContext.tests
  },
  test (file, test, context) {
    const print = new Print({ level: context.logLevel })
    print.debug(
      `Test worker ${threadId}`,
      chalk.cyan(test.name),
      chalk.gray(relative(process.cwd(), file.path))
    )
    return new Promise(async (resolve, reject) => {
      const expect = require('expect')
      const {
        SnapshotState,
        addSerializer,
        toMatchSnapshot,
        toMatchInlineSnapshot,
        toThrowErrorMatchingSnapshot,
        toThrowErrorMatchingInlineSnapshot,
        utils
      } = require('jest-snapshot')
      const { toHookExec } = require('./lib')

      // Extend the expect with jest-snapshot to allow snapshot testing.
      expect.extend({
        toMatchInlineSnapshot,
        toMatchSnapshot,
        toThrowErrorMatchingInlineSnapshot,
        toThrowErrorMatchingSnapshot
      })
      expect.addSnapshotSerializer = addSerializer

      // Create the context object that provides data and utilities to tests.
      const testContext = {
        ...file,
        ...test,
        result: {},
        expect,
        fail (reason = 'manual failure') {
          throw new Error(reason)
        },
        pass (reason = 'manual pass') {
          testContext.result.passed = reason
        }
      }
      context.testContext = testContext

      try {
        // Load the test file and extract the test object.
        const { testFn } = require(file.path)[test.key]

        // Update expect's state with the snapshot state and the test name.
        expect.setState({
          assertionCalls: 0,
          suppressedErrors: [],
          snapshotState: new SnapshotState(
            file.snapshotPath,
            context.updateSnapshot
          ),
          currentTestName: test.key
        })

        // Execute each function with the test context exported by the files
        // configured to be called before each test.
        if (context.plugins && context.plugins.length) {
          await pSeries(
            context.plugins.map(toHookExec('beforeEach', context))
          )
        }

        // Perform the given test within the test file and make the expect
        // assertion library available to it.
        const promise = new Promise(async (resolve, reject) => {
          try {
            await testFn(testContext)
            resolve()
          } catch (err) {
            reject(err)
          }
        })
        await pTimeout(promise, context.timeout)

        // Extract expect's state after running the test.
        const { suppressedErrors, assertionCalls } = expect.getState()

        // If there were no assertions executed, fail the test.
        if (!testContext.result.passed && assertionCalls === 0) {
          throw new Error('no assertions made')
        }

        // If expect has a suppressed error (e.g. a snapshot did not match)
        // then throw the error so that the test can be marked as having failed.
        if (suppressedErrors.length) {
          throw suppressedErrors[0]
        }

        const { snapshotState } = expect.getState()
        if (snapshotState.added || snapshotState.updated) {
          testContext.result = {
            counters: Array.from(snapshotState._counters),
            snapshots: {},
            added: snapshotState.added,
            updated: snapshotState.updated
          }
          for (let i = snapshotState._counters.get(test.key); i > 0; i--) {
            const key = utils.testNameToKey(test.key, i)
            testContext.result.snapshots[key] = snapshotState._snapshotData[key]
          }
        }
      } catch (err) {
        testContext.result.failed = err
      } finally {
        try {
          // Execute each function with the test context exported by the files
          // configured to be called after each test.
          if (context.plugins && context.plugins.length) {
            await pSeries(
              context.plugins.map(toHookExec('afterEach', context))
            )
          }

          if (testContext.result.failed) {
            // Delete the matcher result property of the error since it can't be
            // sent over postMessage.
            delete testContext.result.failed.matcherResult

            reject(testContext.result.failed)
          } else {
            resolve(testContext.result)
          }
        } catch (err) {
          reject(err)
        }
      }
    })
  }
})
