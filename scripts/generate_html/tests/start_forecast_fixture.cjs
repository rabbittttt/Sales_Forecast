const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const {once} = require('node:events');
const path = require('node:path');
const assert = require('node:assert/strict');
const sharedPython = require('./shared_python.cjs');

async function startFixture(cwd = path.resolve(__dirname, '..')) {
  const child = spawn(sharedPython(process.env.FORECAST_TEST_PYTHON), ['-B', '-m', 'tests.portal_fixture'], {
    cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(child, 'exit');
  const lines = createInterface({input: child.stdout});
  const firstLine = once(lines, 'line').then(([line]) => Number(line));
  try {
    const port = await Promise.race([firstLine, exited.then(() => 0)]);
    assert(Number.isInteger(port) && port > 0, 'The synthetic server did not start.');
    return {origin: 'http://127.0.0.1:' + port, async close() { child.stdin.end(); await exited; }};
  } catch (error) {
    child.stdin.end();
    throw error;
  } finally {
    lines.close();
  }
}

module.exports = {startFixture};
