// webauthn.ts — the phone's yes (ADR 0014, G5): the two calls that touch the device's authenticator, one to answer
// with a passkey and one to make it. The challenge and the encodings are webauthn-core.ts's.

import { type Assertion, b64u, creationOptions, unb64u } from "./webauthn-core.ts";

export * from "./webauthn-core.ts";

/** Asks the device for the passkey's signature over `challenge`. Throws with the browser's reason (cancelled,
 *  no such passkey on this device...). Only the passkeys the service says are endorsed are offered. */
export async function assertWith(challenge: Uint8Array<ArrayBuffer>, credentialIds: string[]): Promise<Assertion> {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      userVerification: "required",
      timeout: 120_000,
      allowCredentials: credentialIds.map((id) => ({ type: "public-key" as const, id: unb64u(id) })),
    },
  }) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelled");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    credential: b64u(cred.rawId),
    authenticatorData: b64u(r.authenticatorData),
    clientDataJSON: b64u(r.clientDataJSON),
    signature: b64u(r.signature),
  };
}

/** Makes a passkey with the options the service gave, and returns it in the JSON form POST /api/passkeys takes. */
export async function createPasskey(raw: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cred = await navigator.credentials.create({ publicKey: creationOptions(raw) as unknown as PublicKeyCredentialCreationOptions }) as PublicKeyCredential | null;
  if (!cred) throw new Error("cancelled");
  const r = cred.response as AuthenticatorAttestationResponse;
  return {
    id: cred.id,
    rawId: b64u(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: b64u(r.clientDataJSON),
      attestationObject: b64u(r.attestationObject),
      transports: r.getTransports?.() ?? [],
    },
  };
}

/** Whether this browser can make and use a passkey at all (a secure page, and the API). */
export const passkeysSupported = () => typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;
