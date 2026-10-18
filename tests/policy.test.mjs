import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedStudentRequest } from '../src/policy.js';
test('only student routes are public', () => {
  assert(allowedStudentRequest('GET', '/'));
  assert(allowedStudentRequest('POST', '/api/responses'));
  for (const method of ['GET', 'POST']) for (const path of ['/teacher-access', '/api/admin/responses/delete', '/api/display/responses', '/display', '/api/status', '//evil.test/', '/%61pi/status', '/api/student/archive-upload']) assert.equal(allowedStudentRequest(method, path), false);
});
