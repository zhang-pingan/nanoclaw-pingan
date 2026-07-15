export type JsonScalar = null | boolean | number | string;

export type JsonValue = JsonScalar | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface VersionedRef extends JsonObject {
  id: string;
  version: string;
}

export type Sha256Hash = `sha256:${string}`;

export interface ContractArtifactEnvelope<
  TPayload extends JsonObject = JsonObject,
> extends JsonObject {
  format: string;
  ref: VersionedRef;
  version: number;
  domain_separator: string;
  hash: Sha256Hash;
  payload: TPayload;
}
