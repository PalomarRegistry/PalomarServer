/** Fail closed if a runtime test forgets to intercept an outbound request. */
export function rejectOutbound(request) {
  return new Response(
    `runtime tests must not reach ${new URL(request.url).origin}`,
    { status: 502 },
  );
}
