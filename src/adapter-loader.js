import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadAdapterRegistration(adapterPath) {
  if (!adapterPath) return null;
  const resolvedAdapterPath = path.resolve(adapterPath);
  const adapterDirectory = path.dirname(resolvedAdapterPath);
  const adapter = JSON.parse(await readFile(resolvedAdapterPath, "utf8"));
  validateAdapterMetadata(adapter, resolvedAdapterPath);

  const descriptors = await Promise.all(adapter.extension.descriptors.map(async (configuredPath) => {
    const descriptorPath = path.resolve(adapterDirectory, configuredPath);
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8"));
    validateDescriptor(descriptor, descriptorPath);
    return descriptor;
  }));

  const registration = {
    schemaVersion: 1,
    id: adapter.id,
    displayName: adapter.displayName,
    version: adapter.version,
    hostPermissions: [...new Set(adapter.extension.hostPermissions)],
    descriptors
  };
  validateAdapterRegistration(registration, resolvedAdapterPath);
  return registration;
}

export function validateAdapterRegistration(registration, source = "adapter registration") {
  if (
    registration?.schemaVersion !== 1 ||
    !isNonEmptyString(registration.id) ||
    !isNonEmptyString(registration.displayName) ||
    !isNonEmptyString(registration.version)
  ) {
    throw new Error(`Invalid adapter registration metadata: ${source}`);
  }
  if (!Array.isArray(registration.hostPermissions) || registration.hostPermissions.length === 0) {
    throw new Error(`Adapter registration requires host permissions: ${source}`);
  }
  for (const permission of registration.hostPermissions) {
    validateHostPermission(permission, source);
  }
  if (!Array.isArray(registration.descriptors) || registration.descriptors.length === 0) {
    throw new Error(`Adapter registration requires at least one descriptor: ${source}`);
  }
  for (const descriptor of registration.descriptors) {
    validateDescriptor(descriptor, source);
    for (const origin of descriptor.match.origins) {
      const requiredPermission = `${origin}/*`;
      if (!registration.hostPermissions.includes(requiredPermission)) {
        throw new Error(`Descriptor origin '${origin}' is not declared as '${requiredPermission}' by ${source}`);
      }
    }
  }
  return registration;
}

function validateAdapterMetadata(adapter, source) {
  if (
    adapter?.schemaVersion !== 1 ||
    !isNonEmptyString(adapter.id) ||
    !isNonEmptyString(adapter.displayName) ||
    !isNonEmptyString(adapter.version)
  ) {
    throw new Error(`Invalid adapter metadata: ${source}`);
  }
  if (
    !Array.isArray(adapter.extension?.descriptors) ||
    !Array.isArray(adapter.extension?.hostPermissions)
  ) {
    throw new Error(`Adapter extension configuration is incomplete: ${source}`);
  }
}

function validateDescriptor(descriptor, source) {
  if (descriptor?.schemaVersion !== 1 || !isNonEmptyString(descriptor.id) || !isNonEmptyString(descriptor.version)) {
    throw new Error(`Invalid Page Observer descriptor metadata: ${source}`);
  }
  if (!Array.isArray(descriptor.match?.origins) || descriptor.match.origins.length === 0) {
    throw new Error(`Page Observer descriptor has no allowed origins: ${source}`);
  }
  for (const origin of descriptor.match.origins) {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Invalid descriptor origin '${origin}' in ${source}`);
    }
  }
  for (const key of ["pages", "fields", "controls", "values", "collections", "scrollables"]) {
    if (!Array.isArray(descriptor[key])) {
      throw new Error(`Page Observer descriptor '${source}' has invalid ${key}.`);
    }
  }
}

function validateHostPermission(permission, source) {
  if (!isNonEmptyString(permission) || !/^https?:\/\/[^/]+\/\*$/.test(permission)) {
    throw new Error(`Invalid adapter host permission '${String(permission)}' in ${source}`);
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
