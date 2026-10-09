// Secrets carried in a URL (a sign-in token in the fragment, an API key in the query, a password in the
// userinfo) must not reach results, events, logs or reports. Pure: the value of a secret-looking
// parameter is replaced, the rest of the URL is kept so a route still reads as a route.

// A parameter name is secret-looking when it contains one of these words anywhere (accessToken,
// client_secret, X-Amz-Signature, refresh_token[0]) ...
const ANYWHERE = 'token|secret|passw(?:or)?d|pwd|api[_.-]?key|signature|jwt|credential|bearer|session';
// ... or is one of these short words on its own or as a delimited part (sig, auth, otp, key, code would
// otherwise match "design", "author", "hotpink"). A camelCase tail (userAuth, idSig) counts too.
const WHOLE = 'sig|auth|otp|pin|pass|sid';
const PART = '[\\w.\\-\\[\\]%]*';
const NAME_I = `(?:${PART}(?:${ANYWHERE})${PART}|(?:${PART}[_.\\-\\]])?(?:${WHOLE})(?:[_.\\-\\[]${PART})?)`;
const NAME_CAMEL = `${PART}[a-z0-9](?:Sig|Auth|Otp|Pin|Pass)`;
const param = (name: string, flags: string) => new RegExp(`([?&#/;!]|%3[fF]|%2[36fF])(${name})(=|%3[dD])((?:(?!%2[36])[^&#;\\s"'<>])*)`, flags);
// A URL nested in a parameter arrives percent-encoded (%3F ? · %26 & · %23 # · %2F / · %3D =).
const SECRET_PARAM_I = param(NAME_I, 'gi');
// The camelCase tail is matched with its capitals, so "compass" and "spin" stay as they are.
const SECRET_PARAM = param(NAME_CAMEL, 'g');
const USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]*@/gi;

export const REDACTED_PARAM = '‹redacted›';

/** A URL, route or message with the values of secret-looking parameters and any URL userinfo replaced. */
export function redactUrlSecrets(text: string): string {
  const swap = (_m: string, sep: string, key: string, eq: string) => `${sep}${key}${eq}${REDACTED_PARAM}`;
  return text.replace(USERINFO, `$1${REDACTED_PARAM}@`).replace(SECRET_PARAM_I, swap).replace(SECRET_PARAM, swap);
}
