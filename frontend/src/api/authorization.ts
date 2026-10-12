let apiCredential: string | null = null;

export function setApiCredential(credential: string | null): void {
  apiCredential = credential;
}

export function getApiCredential(): string | null {
  return apiCredential;
}

export function addAuthorizationHeader(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  if (apiCredential) {
    result.set("Authorization", `Bearer ${apiCredential}`);
  }
  return result;
}
