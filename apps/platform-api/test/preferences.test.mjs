import assert from "node:assert/strict";
import { test } from "node:test";

import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';

async function fixture() {
  const repository = new MemoryIdentityRepository();
  const identity = await repository.insertIdentity({
    loginName: "member",
    normalizedLoginName: "member",
    displayName: "Member",
    passwordHash: "test-only-password-hash",
  });
  const audit = [];
  const service = new IdentityPreferencesService({
    repository,
    audit: async (event) => audit.push(event),
    clock: () => new Date("2026-08-10T00:00:00.000Z"),
  });
  return { audit, identity, repository, service };
}

test('every product locale round trips on the same isolated account',async()=>{
 const {identity,service}=await fixture();const context={identityId:identity.id};
 for(const locale of supportedLocaleCodes){await service.updatePreferredLocale({context,locale});assert.equal(await service.preferredLocale({context}),locale);}
});

test("locale preference persists on the authenticated local account", async () => {
  const { audit, identity, repository, service } = await fixture();
  const context = { identityId: identity.id };
  assert.equal(identity.preferredLocaleExplicit, false);
  assert.equal(await service.preferredLocale({ context }), "zh-CN");
  assert.deepEqual(await service.updatePreferredLocale({ context, locale: "en" }), {
    identityId: identity.id,
    preferredLocale: "en",
  });
  assert.equal((await repository.findIdentity(identity.id)).preferredLocale, "en");
  assert.equal((await repository.findIdentity(identity.id)).preferredLocaleExplicit, true);
  assert.equal(await new IdentityPreferencesService({ repository }).preferredLocale({ context }), "en");
  assert.equal(audit[0].action, "identity.preferred_locale_changed");
  assert.equal(audit[0].previousLocale, "zh-CN");
});

test("theme preference persists light, dark, or system on the authenticated account", async () => {
  const { audit, identity, repository, service } = await fixture();
  const context = { identityId: identity.id };
  assert.equal(await service.preferredTheme({ context }), "system");
  assert.deepEqual(await service.updatePreferredTheme({ context, theme: "dark" }), {
    identityId: identity.id,
    preferredTheme: "dark",
  });
  assert.equal((await repository.findIdentity(identity.id)).preferredTheme, "dark");
  assert.equal(await new IdentityPreferencesService({ repository }).preferredTheme({ context }), "dark");
  assert.equal(audit[0].action, "identity.preferred_theme_changed");
  await assert.rejects(
    service.updatePreferredTheme({ context, theme: "contrast" }),
    (error) => error.code === "invalid_theme" && error.status === 400,
  );
});

test("locale preference rejects unsupported, cross-account, and disabled updates", async () => {
  const { identity, repository, service } = await fixture();
  const context = { identityId: identity.id };
  await assert.rejects(
    service.updatePreferredLocale({ context, locale: "zz-ZZ" }),
    (error) => error.code === "invalid_locale" && error.status === 400,
  );
  await assert.rejects(
    service.updatePreferredLocale({ context, identityId: "another-user", locale: "en" }),
    (error) => error.code === "access_denied" && error.status === 403,
  );
  await repository.disableIdentity(identity.id, new Date("2026-08-10T00:01:00.000Z"));
  await assert.rejects(
    service.updatePreferredLocale({ context, locale: "en" }),
    (error) => error.code === "invalid_session" && error.status === 401,
  );
});
