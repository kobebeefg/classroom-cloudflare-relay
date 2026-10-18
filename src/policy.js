// Deliberately excludes all teacher, display, export, filesystem and ZIP routes.
function allowedStudentRequest(method, target) {
  if (typeof target !== 'string' || target.length > 2048 || !target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20]/.test(target) || /[%\\\x00-\x20]/.test(target.split('?')[0])) return false;
  const pathname = target.split('?')[0];
  if (method === 'GET') return ['/', '/join', '/student.js', '/student.css', '/privacy.html', '/api/student/status'].includes(pathname)
    || /^\/uploads\/student-image-[a-z0-9-]+\.(png|jpg|gif|webp)$/i.test(pathname);
  return method === 'POST' && ['/join', '/api/responses', '/api/student/image-upload'].includes(pathname);
}
export { allowedStudentRequest };
export const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
