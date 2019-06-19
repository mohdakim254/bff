const { print } = require('@ianwalter/print')

module.exports = {
  before (context) {
    context.beforeMessage = 'before was here'
    print.log('before executed')
  },
  registration (file, context) {
    context.augmentTests = tests => tests.reduce(
      (acc, test) => {
        if (test.key === 'registration') {
          return acc.concat([
            { ...test, name: 'registration [ONE]' },
            { ...test, name: 'registration [TWO]' }
          ])
        }
        return acc.concat([test])
      },
      []
    )
  },
  beforeEach (file, context) {
    context.beforeEachMessage = 'beforeEach was here'
    if (context.testContext.name === 'beforeEach') {
      print.log('beforeEach executed', context.beforeMessage)
    }
  },
  afterEach (file, context) {
    if (context.testContext.name === 'afterEach') {
      print.log(
        'afterEach executed',
        context.beforeMessage,
        context.beforeEachMessage
      )
    }
  },
  after (context) {
    print.log('after executed', context.beforeMessage)
  }
}
