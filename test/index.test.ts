import {expect, test} from '@oclif/test'

import cmd = require('../src')

describe('zztop', () => {
  test
  .stdout()
  .do(() => cmd.run([]))
  .exit(2)
  .it('fails without arguments')

  test
  .stdout()
  .do(() => cmd.run(['test/testdef.json']))
  .it('runs testdef.json', ctx => {
    expect(ctx.stdout).to.contain('Test definition file: test/testdef.json')
  })
})
