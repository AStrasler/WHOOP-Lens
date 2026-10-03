// Returns the OpenAI domain-verification token with no added whitespace or JSON.
export function openaiAppsChallengeResponse(token) {
  if (typeof token !== "string") {
    return new Response("", {
      status: 404,
      headers: { "content-type": "text/plain" },
    });
  }
  return new Response(token, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
