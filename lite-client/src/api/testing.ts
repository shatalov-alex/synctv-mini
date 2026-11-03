// Test helpers (not shipped: only imported from *.test.ts).
export function fakeJwt(exp: number | undefined): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64(exp === undefined ? { sub: 'u' } : { sub: 'u', exp })}.sig`;
}
