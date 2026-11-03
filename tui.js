// @bun
// src/tui.tsx
import { Plugin } from "@opencode/plugin/tui";
import { createEffect, on } from "solid-js";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var string = { type: "string" };
var stringMap = { type: "object", additionalProperties: { type: "string" } };
var result = { type: "object", additionalProperties: true };
var sessionInput = {
  type: "object",
  properties: {
    sessionID: string,
    baseEnv: stringMap
  },
  additionalProperties: false
};
var sessionProfileInput = {
  type: "object",
  properties: {
    sessionID: string,
    profile: string,
    baseEnv: stringMap
  },
  required: ["sessionID", "profile"],
  additionalProperties: false
};
var sessionKeyInput = {
  type: "object",
  properties: {
    sessionID: string,
    key: string,
    baseEnv: stringMap
  },
  required: ["sessionID", "key"],
  additionalProperties: false
};
var sessionValueInput = {
  type: "object",
  properties: {
    sessionID: string,
    key: string,
    value: string,
    baseEnv: stringMap
  },
  required: ["sessionID", "key", "value"],
  additionalProperties: false
};
var profileNameInput = {
  type: "object",
  properties: {
    profile: string,
    baseEnv: stringMap
  },
  required: ["profile"],
  additionalProperties: false
};
var definition = Rpc.define({
  id: "env.manager",
  events: {},
  methods: {
    state: { input: sessionInput, output: result },
    resolve: { input: sessionInput, output: result },
    activeProfile: {
      input: {
        type: "object",
        properties: { sessionID: string },
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { profile: string, defaultProfile: string },
        required: ["profile"],
        additionalProperties: false
      }
    },
    setProfile: { input: sessionProfileInput, output: result },
    setOverride: { input: sessionValueInput, output: result },
    unsetKey: { input: sessionKeyInput, output: result },
    clearOverrides: { input: sessionInput, output: result },
    createProfile: {
      input: {
        type: "object",
        properties: { name: string, from: string, baseEnv: stringMap },
        required: ["name"],
        additionalProperties: false
      },
      output: result
    },
    copyProfile: {
      input: {
        type: "object",
        properties: { from: string, to: string, baseEnv: stringMap },
        required: ["from", "to"],
        additionalProperties: false
      },
      output: result
    },
    renameProfile: {
      input: {
        type: "object",
        properties: { from: string, to: string, baseEnv: stringMap },
        required: ["from", "to"],
        additionalProperties: false
      },
      output: result
    },
    deleteProfile: {
      input: {
        type: "object",
        properties: { name: string, baseEnv: stringMap },
        required: ["name"],
        additionalProperties: false
      },
      output: result
    },
    setVariable: {
      input: {
        type: "object",
        properties: { profile: string, key: string, value: string, baseEnv: stringMap },
        required: ["profile", "key", "value"],
        additionalProperties: false
      },
      output: result
    },
    removeVariable: {
      input: {
        type: "object",
        properties: { profile: string, key: string, baseEnv: stringMap },
        required: ["profile", "key"],
        additionalProperties: false
      },
      output: result
    },
    setSecret: {
      input: {
        type: "object",
        properties: { profile: string, name: string, entry: string, baseEnv: stringMap },
        required: ["profile", "name", "entry"],
        additionalProperties: false
      },
      output: result
    },
    removeSecret: {
      input: {
        type: "object",
        properties: { profile: string, name: string, baseEnv: stringMap },
        required: ["profile", "name"],
        additionalProperties: false
      },
      output: result
    },
    secretStoreStatus: {
      input: {
        type: "object",
        properties: { baseEnv: stringMap },
        additionalProperties: false
      },
      output: result
    },
    secretStoreGet: {
      input: {
        type: "object",
        properties: {
          entries: { type: "array", items: string, maxItems: 64 }
        },
        required: ["entries"],
        additionalProperties: false
      },
      output: result
    },
    vaultStatus: {
      input: {
        type: "object",
        properties: { baseEnv: stringMap },
        additionalProperties: false
      },
      output: result
    },
    vaultGet: {
      input: {
        type: "object",
        properties: {
          entries: { type: "array", items: string, maxItems: 64 }
        },
        required: ["entries"],
        additionalProperties: false
      },
      output: result
    },
    addEnvFile: {
      input: {
        type: "object",
        properties: { profile: string, path: string, baseEnv: stringMap },
        required: ["profile", "path"],
        additionalProperties: false
      },
      output: result
    },
    removeEnvFile: {
      input: {
        type: "object",
        properties: { profile: string, path: string, baseEnv: stringMap },
        required: ["profile", "path"],
        additionalProperties: false
      },
      output: result
    },
    clearEnvFiles: { input: profileNameInput, output: result },
    setDefaultProfile: {
      input: {
        type: "object",
        properties: { name: string, baseEnv: stringMap },
        required: ["name"],
        additionalProperties: false
      },
      output: result
    },
    reload: { input: sessionInput, output: result }
  }
});
var EnvManager = definition;

// src/tui.tsx
var SECRET = /(?:^|_)(password|passphrase|secret|token|api[_-]?key|credential|private[_-]?key|auth)(?:_|$)/i;
var CUSTOM = "__custom__";
var tui_default = Plugin.define({
  id: "env.manager.tui",
  async setup(context) {
    const rpc = context.client.rpc(EnvManager);
    const terminalEnv = snapshotEnvironment();
    const applied = new Set;
    const applying = new Set;
    function toast(message, variant = "info", title = "Environment") {
      context.ui.toast.show({
        title,
        message,
        variant,
        duration: variant === "error" ? 7000 : 3500
      });
    }
    function toastError(prefix, error) {
      toast(`${prefix}: ${messageOf(error)}`, "error");
    }
    function currentSessionID() {
      try {
        const route = context.ui.router.current();
        if (route.type === "session")
          return route.sessionID;
      } catch {}
      return context.ui.panel.current()?.sessionID;
    }
    async function sessionLocation(sessionID) {
      if (!sessionID)
        return context.location ?? context.data.location.default();
      let info = context.data.session.get(sessionID);
      if (!info) {
        await context.data.session.sync(sessionID).catch(() => {
          return;
        });
        info = context.data.session.get(sessionID);
      }
      return info?.location ?? context.location ?? context.data.location.default();
    }
    async function getState(sessionID, location) {
      return await rpc.state({
        sessionID,
        baseEnv: terminalEnv
      }, {
        location: location ?? await sessionLocation(sessionID)
      });
    }
    async function call(method, input, sessionID) {
      const location = await sessionLocation(sessionID);
      return await rpc[method](input, {
        location
      });
    }
    async function applyState(sessionID, state, quiet = false) {
      if (!sessionID) {
        if (!quiet)
          toast("Open a session first; the profile was saved for this directory.", "warning");
        return false;
      }
      try {
        await context.client.session.environment({
          sessionID,
          variables: state.environment
        });
        if (!quiet) {
          toast(`Applied "${state.profile}" (${Object.keys(state.environment).length} variables)`, "success");
        }
        return true;
      } catch (error) {
        if (!quiet)
          toastError("Could not apply environment", error);
        return false;
      }
    }
    async function ensureApplied(sessionID, location) {
      if (applied.has(sessionID))
        return;
      applied.add(sessionID);
      try {
        const state = await getState(sessionID, location);
        await applyState(sessionID, state, true);
      } catch (error) {
        applied.delete(sessionID);
        console.error("[env-manager] automatic apply failed", error);
      }
    }
    async function reapply(sessionID, location) {
      if (applying.has(sessionID))
        return;
      applying.add(sessionID);
      try {
        const state = await getState(sessionID, location);
        await applyState(sessionID, state, true);
      } catch (error) {
        console.error("[env-manager] refresh apply failed", error);
      } finally {
        applying.delete(sessionID);
      }
    }
    function sourceLabel(source) {
      if (source === "parent")
        return "Parent shell";
      if (source === "session")
        return "Session override";
      if (source.startsWith("file:"))
        return `Env file ${source.slice(5)}`;
      if (source.startsWith("profile:"))
        return `Profile ${source.slice(8)}`;
      return source;
    }
    function chainLabel(chain) {
      return chain.map(sourceLabel).join(" \u2190 ");
    }
    function visibleValue(entry, reveal) {
      if (!reveal && SECRET.test(entry.key))
        return "\u2022\u2022\u2022\u2022\u2022\u2022";
      return entry.value.replace(/\r?\n/g, "\\n").replace(/\t/g, "\\t");
    }
    function truncate(value, limit = 140) {
      return value.length > limit ? `${value.slice(0, limit - 1)}\u2026` : value;
    }
    function profileDescription(profile) {
      const parts = [`${profile.variableCount} variable${profile.variableCount === 1 ? "" : "s"}`];
      if (profile.secretCount)
        parts.push(`${profile.secretCount} secret${profile.secretCount === 1 ? "" : "s"}`);
      parts.push(profile.envFiles.length ? profile.envFiles.join(", ") : "no .env files");
      if (profile.isDefault)
        parts.push("default for new sessions");
      if (profile.active)
        parts.push("active");
      return parts.join(" \xB7 ");
    }
    async function showSecretStoreStatus(configPath, sessionID) {
      try {
        const status = await call("secretStoreStatus", {
          baseEnv: terminalEnv
        }, sessionID);
        if (!status?.configured) {
          await context.ui.dialog.alert({
            title: "Secret store not configured",
            message: `Add a "secretStore" block to ${configPath}, or a global layer in ~/.config/opencode/env-manager.json.`
          });
          return;
        }
        const lines = [];
        for (const [index, layer] of (status.layers ?? []).entries()) {
          lines.push(`${index + 1}. ${layer.store ?? layer.provider}`);
          if (layer.ok)
            lines.push(`   ok \xB7 ${layer.entries.length} entries`);
          else if (layer.missing)
            lines.push("   not created yet; inherited layers still apply");
          else
            lines.push(`   failed: ${layer.error}`);
          if (layer.ok && layer.entries.length)
            lines.push(`   ${layer.entries.join(", ")}`);
          for (const warning of layer.warnings ?? [])
            lines.push(`   \u26A0 ${warning}`);
        }
        if (status.warnings?.length)
          lines.push("", ...status.warnings.map((warning) => `\u26A0 ${warning}`));
        await context.ui.dialog.alert({
          title: `Secret store status \u2014 ${status.layers.length} layer${status.layers.length === 1 ? "" : "s"}`,
          message: lines.join(`
`)
        });
      } catch (error) {
        toastError("Secret store status failed", error);
      }
    }
    async function pickProfile(state, title, current) {
      return context.ui.dialog.select({
        title,
        current,
        options: state.profiles.map((profile) => ({
          title: profile.name,
          value: profile.name,
          description: profileDescription(profile),
          category: profile.active ? "Active" : undefined
        }))
      });
    }
    async function viewEnvironment(state) {
      let reveal = false;
      for (;; ) {
        let revealRequested = false;
        const options = [...state.secrets.map((secret) => ({
          title: `${secret.name} = \u2022\u2022\u2022\u2022\u2022\u2022 (secret store)`,
          value: `secret:${secret.name}`,
          description: `entry ${secret.entry} \xB7 injected per command`,
          category: "Secrets"
        })), ...state.entries.map((entry) => ({
          title: `${entry.key} = ${truncate(visibleValue(entry, reveal))}`,
          value: entry.key,
          description: entry.chain.length > 1 ? chainLabel(entry.chain) : undefined,
          category: sourceLabel(entry.source)
        })), ...state.unset.map((entry) => ({
          title: `${entry.key} (unset)`,
          value: `unset:${entry.key}`,
          description: sourceLabel(entry.source),
          category: "Unset"
        })), ...state.warnings.map((warning, index) => ({
          title: `\u26A0 ${truncate(warning, 100)}`,
          value: `warning:${index}`,
          category: "Warnings"
        }))];
        const choice = await context.ui.dialog.select({
          title: `Environment \u2014 ${state.profile} (${state.entries.length})`,
          placeholder: "Search variables",
          options,
          search: (query, available) => {
            const needle = query.trim().toLowerCase();
            if (!needle)
              return available;
            return available.filter((option) => option.title.toLowerCase().includes(needle) || (option.description ?? "").toLowerCase().includes(needle));
          },
          actions: reveal ? [] : [{
            bind: "ctrl+r",
            title: "Reveal secrets",
            selection: "none",
            onTrigger: () => {
              reveal = true;
              revealRequested = true;
              context.ui.dialog.clear();
            }
          }]
        });
        if (revealRequested)
          continue;
        if (!choice)
          return;
        if (choice.startsWith("secret:")) {
          const name = choice.slice(7);
          const binding = state.secrets.find((item) => item.name === name);
          if (!binding)
            continue;
          await context.ui.dialog.alert({
            title: binding.name,
            message: `Stored in the secret store as "${binding.entry}".

This value is never displayed and never added to the session environment. It is decrypted only for a shell command that references $${binding.name}, after you approve that command.`
          });
          continue;
        }
        if (choice.startsWith("unset:")) {
          const key = choice.slice(6);
          const entry = state.unset.find((item) => item.key === key);
          await context.ui.dialog.alert({
            title: key,
            message: `Unset by session override.

Previous source: ${entry ? sourceLabel(entry.source) : "unknown"}`
          });
          continue;
        }
        if (choice.startsWith("warning:")) {
          const index = Number(choice.slice(8));
          const warning = state.warnings[index] ?? "Unknown warning";
          await context.ui.dialog.alert({
            title: "Environment warning",
            message: warning
          });
          continue;
        }
        const entry = state.entries.find((item) => item.key === choice);
        if (!entry)
          continue;
        await context.ui.dialog.alert({
          title: entry.key,
          message: `Value:
${entry.value}

Source: ${sourceLabel(entry.source)}
Override chain: ${chainLabel(entry.chain)}`
        });
      }
    }
    async function afterProfileEdit(sessionID, activeNames, savedName) {
      if (!sessionID) {
        toast(`Saved "${savedName}". Open a session to apply it.`, "info");
        return;
      }
      const fresh = await getState(sessionID);
      if (activeNames.includes(fresh.profile)) {
        await applyState(sessionID, fresh);
      } else {
        toast(`Saved "${savedName}". Switch to it to apply it to this session.`, "info");
      }
    }
    async function editProfile(sessionID, state) {
      const name = await pickProfile(state, "Edit profile", state.profile);
      if (!name)
        return;
      for (;; ) {
        const fresh = await getState(sessionID);
        const profile = fresh.profiles.find((item) => item.name === name);
        if (!profile) {
          toast(`Profile "${name}" no longer exists.`, "warning");
          return;
        }
        const action = await context.ui.dialog.select({
          title: `Edit "${name}"`,
          options: [{
            title: "Set / override variable\u2026",
            value: "set"
          }, {
            title: "Remove variable\u2026",
            value: "remove",
            disabled: profile.variableCount === 0
          }, {
            title: "Manage secret-store secrets\u2026",
            value: "secrets",
            description: profile.secretCount ? `${profile.secretCount} bound` : "none bound"
          }, {
            title: "Add .env file\u2026",
            value: "add-file"
          }, {
            title: "Remove .env file\u2026",
            value: "remove-file",
            disabled: profile.envFiles.length === 0
          }, {
            title: "Clear .env files",
            value: "clear-files",
            disabled: profile.envFiles.length === 0
          }, {
            title: "Rename profile\u2026",
            value: "rename"
          }, {
            title: "Back",
            value: "back"
          }]
        });
        if (!action || action === "back")
          return;
        try {
          if (action === "set") {
            const key = (await context.ui.dialog.prompt({
              title: "Variable name",
              description: "Letters, digits and underscores; must not start with a digit.",
              placeholder: "API_URL"
            }))?.trim();
            if (!key)
              continue;
            const value = await context.ui.dialog.prompt({
              title: `Value for ${key}`,
              placeholder: "value",
              value: profile.variables[key] ?? ""
            });
            if (value === undefined)
              continue;
            await call("setVariable", {
              profile: name,
              key,
              value,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name], name);
          }
          if (action === "remove") {
            const key = await context.ui.dialog.select({
              title: `Remove variable from "${name}"`,
              options: Object.keys(profile.variables).sort().map((item) => ({
                title: item,
                value: item,
                description: truncate(profile.variables[item])
              }))
            });
            if (!key)
              continue;
            await call("removeVariable", {
              profile: name,
              key,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name], name);
          }
          if (action === "secrets") {
            const sub = await context.ui.dialog.select({
              title: `Secret-store secrets for "${name}"`,
              options: [{
                title: "Bind a variable to a secret-store entry\u2026",
                value: "add"
              }, {
                title: "Remove a binding\u2026",
                value: "remove",
                disabled: profile.secretCount === 0
              }, {
                title: "Secret store status / test decryption\u2026",
                value: "test"
              }, {
                title: "Back",
                value: "back"
              }]
            });
            if (!sub || sub === "back")
              continue;
            if (sub === "add") {
              const variable = (await context.ui.dialog.prompt({
                title: "Variable name",
                description: "The name a shell command references as $NAME.",
                placeholder: "OPENAI_API_KEY"
              }))?.trim();
              if (!variable)
                continue;
              const entry = (await context.ui.dialog.prompt({
                title: `Secret-store entry for ${variable}`,
                description: "Entry name inside the decrypted store, for example openai/api-key.",
                placeholder: "openai/api-key"
              }))?.trim();
              if (!entry)
                continue;
              await call("setSecret", {
                profile: name,
                name: variable,
                entry,
                baseEnv: terminalEnv
              }, sessionID);
              await afterProfileEdit(sessionID, [name], name);
            }
            if (sub === "remove") {
              const variable = await context.ui.dialog.select({
                title: `Remove secret-store binding from "${name}"`,
                options: Object.keys(profile.secrets).sort().map((item) => ({
                  title: item,
                  value: item,
                  description: `entry ${profile.secrets[item]}`
                }))
              });
              if (!variable)
                continue;
              await call("removeSecret", {
                profile: name,
                name: variable,
                baseEnv: terminalEnv
              }, sessionID);
              await afterProfileEdit(sessionID, [name], name);
            }
            if (sub === "test") {
              await showSecretStoreStatus(fresh.configPath, sessionID);
            }
            continue;
          }
          if (action === "add-file") {
            const already = new Set(profile.envFiles);
            const available = fresh.availableEnvFiles.filter((file) => !already.has(file));
            const choice = await context.ui.dialog.select({
              title: `Add .env file to "${name}"`,
              options: [...available.map((file) => ({
                title: file,
                value: file
              })), {
                title: "Enter a path\u2026",
                value: CUSTOM
              }]
            });
            if (!choice)
              continue;
            const file = choice === CUSTOM ? (await context.ui.dialog.prompt({
              title: "Path to .env file",
              placeholder: ".env.local",
              value: ".env.local"
            }))?.trim() : choice;
            if (!file)
              continue;
            await call("addEnvFile", {
              profile: name,
              path: file,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name], name);
          }
          if (action === "remove-file") {
            const file = await context.ui.dialog.select({
              title: `Remove .env file from "${name}"`,
              options: profile.envFiles.map((item) => ({
                title: item,
                value: item
              }))
            });
            if (!file)
              continue;
            await call("removeEnvFile", {
              profile: name,
              path: file,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name], name);
          }
          if (action === "clear-files") {
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear .env files",
              message: `Stop loading all .env files for "${name}"?`,
              label: {
                confirm: "Clear",
                cancel: "Cancel"
              }
            });
            if (!confirmed)
              continue;
            await call("clearEnvFiles", {
              profile: name,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name], name);
          }
          if (action === "rename") {
            const renamed = (await context.ui.dialog.prompt({
              title: `Rename "${name}"`,
              placeholder: "new-profile-name",
              value: name
            }))?.trim();
            if (!renamed || renamed === name)
              continue;
            await call("renameProfile", {
              from: name,
              to: renamed,
              baseEnv: terminalEnv
            }, sessionID);
            await afterProfileEdit(sessionID, [name, renamed], renamed);
            return;
          }
        } catch (error) {
          toastError("Profile update failed", error);
        }
      }
    }
    async function manageProfiles(sessionID, state) {
      const action = await context.ui.dialog.select({
        title: "Manage profiles",
        options: [{
          title: "Create profile\u2026",
          value: "create"
        }, {
          title: "Copy profile\u2026",
          value: "copy"
        }, {
          title: "Rename profile\u2026",
          value: "rename"
        }, {
          title: "Delete profile\u2026",
          value: "delete"
        }, {
          title: "Set default profile for new sessions\u2026",
          value: "default"
        }]
      });
      if (!action)
        return;
      try {
        if (action === "create") {
          const name = (await context.ui.dialog.prompt({
            title: "New profile",
            placeholder: "dev"
          }))?.trim();
          if (!name)
            return;
          await call("createProfile", {
            name,
            baseEnv: terminalEnv
          }, sessionID);
          toast(`Created profile "${name}"`, "success");
          if (sessionID && await context.ui.dialog.confirm({
            title: "Switch session?",
            message: `Use "${name}" in this session now?`
          })) {
            const switched = await call("setProfile", {
              sessionID,
              profile: name,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, switched);
          }
          return;
        }
        if (action === "copy") {
          const from = await pickProfile(state, "Copy which profile?");
          if (!from)
            return;
          const to = (await context.ui.dialog.prompt({
            title: `Copy "${from}" to`,
            placeholder: `${from}-copy`
          }))?.trim();
          if (!to)
            return;
          await call("copyProfile", {
            from,
            to,
            baseEnv: terminalEnv
          }, sessionID);
          toast(`Copied "${from}" to "${to}"`, "success");
          return;
        }
        if (action === "rename") {
          const from = await pickProfile(state, "Rename which profile?");
          if (!from)
            return;
          const to = (await context.ui.dialog.prompt({
            title: `Rename "${from}"`,
            placeholder: from,
            value: from
          }))?.trim();
          if (!to || to === from)
            return;
          await call("renameProfile", {
            from,
            to,
            baseEnv: terminalEnv
          }, sessionID);
          toast(`Renamed "${from}" to "${to}"`, "success");
          const latest = await getState(sessionID);
          if (sessionID && [from, to].includes(latest.profile))
            await applyState(sessionID, latest);
          return;
        }
        if (action === "delete") {
          const name = await pickProfile(state, "Delete which profile?");
          if (!name)
            return;
          if (name === "default") {
            await context.ui.dialog.alert({
              title: "Cannot delete",
              message: "The default profile is required."
            });
            return;
          }
          const confirmed = await context.ui.dialog.confirm({
            title: `Delete "${name}"?`,
            message: "This removes the profile from the work directory. Sessions using it fall back to the default profile.",
            label: {
              confirm: "Delete",
              cancel: "Cancel"
            }
          });
          if (!confirmed)
            return;
          await call("deleteProfile", {
            name,
            baseEnv: terminalEnv
          }, sessionID);
          toast(`Deleted "${name}"`, "success");
          const latest = await getState(sessionID);
          if (sessionID && latest.profile !== name)
            await applyState(sessionID, latest);
          return;
        }
        if (action === "default") {
          const name = await pickProfile(state, "Default profile for new sessions", state.defaultProfile);
          if (!name)
            return;
          await call("setDefaultProfile", {
            name,
            baseEnv: terminalEnv
          }, sessionID);
          toast(`New sessions will use "${name}"`, "success");
          const use = await context.ui.dialog.confirm({
            title: "Apply now?",
            message: `Switch this session to "${name}" as well?`
          });
          if (use && sessionID) {
            const switched = await call("setProfile", {
              sessionID,
              profile: name,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, switched);
          }
          return;
        }
      } catch (error) {
        toastError("Profile management failed", error);
      }
    }
    async function openMenu(startSessionID) {
      let sessionID = startSessionID ?? currentSessionID();
      for (;; ) {
        let state;
        try {
          state = await getState(sessionID);
        } catch (error) {
          toastError("Environment", error);
          return;
        }
        const hasOverrides = Object.keys(state.overrides.set).length > 0 || state.overrides.unset.length > 0;
        const choice = await context.ui.dialog.select({
          title: `Environment \u2014 ${state.profile}${sessionID ? "" : " (no session)"}`,
          current: "view",
          options: [{
            title: "View combined environment",
            value: "view",
            description: `${state.entries.length} variables${state.unset.length ? `, ${state.unset.length} unset` : ""}${state.warnings.length ? `, ${state.warnings.length} warnings` : ""}`,
            category: "Inspect"
          }, {
            title: "Switch profile for this session",
            value: "switch",
            description: `Current: ${state.profile}`,
            category: "Profile",
            disabled: !sessionID
          }, {
            title: "Edit profile\u2026",
            value: "edit",
            category: "Profile"
          }, {
            title: "Manage profiles\u2026",
            value: "manage",
            category: "Profile"
          }, {
            title: "Set session-only override\u2026",
            value: "override",
            category: "Session",
            disabled: !sessionID
          }, {
            title: "Unset variable for this session\u2026",
            value: "unset",
            category: "Session",
            disabled: !sessionID
          }, {
            title: "Clear session overrides",
            value: "clear",
            category: "Session",
            disabled: !sessionID || !hasOverrides
          }, {
            title: "Reapply to current session",
            value: "apply",
            category: "Session",
            disabled: !sessionID
          }, {
            title: "Set default profile for new sessions\u2026",
            value: "default",
            category: "Defaults"
          }, {
            title: "Secret store status\u2026",
            value: "secret-store",
            description: state.secretStore.configured ? `${state.secretStore.stores.length} layer${state.secretStore.stores.length === 1 ? "" : "s"} \xB7 ${state.secrets.length} bound` : "not configured",
            category: "Secrets"
          }, {
            title: "Reload config from disk",
            value: "reload",
            category: "Defaults"
          }]
        });
        if (!choice)
          return;
        try {
          if (choice === "view") {
            await viewEnvironment(state);
          }
          if (choice === "switch") {
            if (!sessionID)
              continue;
            const profile = await pickProfile(state, "Profile for this session", state.profile);
            if (!profile)
              continue;
            const next = await call("setProfile", {
              sessionID,
              profile,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, next);
          }
          if (choice === "edit") {
            await editProfile(sessionID, state);
          }
          if (choice === "manage") {
            await manageProfiles(sessionID, state);
          }
          if (choice === "override") {
            if (!sessionID)
              continue;
            const key = (await context.ui.dialog.prompt({
              title: "Session-only variable",
              description: "This override is not saved to any profile.",
              placeholder: "DEBUG"
            }))?.trim();
            if (!key)
              continue;
            const value = await context.ui.dialog.prompt({
              title: `Session-only value for ${key}`,
              placeholder: "true",
              value: state.environment[key] ?? ""
            });
            if (value === undefined)
              continue;
            const next = await call("setOverride", {
              sessionID,
              key,
              value,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, next);
          }
          if (choice === "unset") {
            if (!sessionID)
              continue;
            const options = state.entries.map((entry) => ({
              title: entry.key,
              value: entry.key,
              description: `${sourceLabel(entry.source)} \xB7 ${truncate(visibleValue(entry, false), 60)}`
            }));
            options.unshift({
              title: "Enter another variable name\u2026",
              value: CUSTOM,
              description: ""
            });
            const picked = await context.ui.dialog.select({
              title: "Unset for this session",
              options
            });
            if (!picked)
              continue;
            const key = picked === CUSTOM ? (await context.ui.dialog.prompt({
              title: "Variable name to unset",
              placeholder: "DEBUG"
            }))?.trim() : picked;
            if (!key)
              continue;
            const next = await call("unsetKey", {
              sessionID,
              key,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, next);
          }
          if (choice === "clear") {
            if (!sessionID)
              continue;
            const confirmed = await context.ui.dialog.confirm({
              title: "Clear session overrides",
              message: "Remove all session-only overrides from this session?",
              label: {
                confirm: "Clear",
                cancel: "Cancel"
              }
            });
            if (!confirmed)
              continue;
            const next = await call("clearOverrides", {
              sessionID,
              baseEnv: terminalEnv
            }, sessionID);
            await applyState(sessionID, next);
          }
          if (choice === "apply") {
            if (!sessionID)
              continue;
            const next = await getState(sessionID);
            await applyState(sessionID, next);
          }
          if (choice === "default") {
            const profile = await pickProfile(state, "Default profile for new sessions", state.defaultProfile);
            if (!profile)
              continue;
            await call("setDefaultProfile", {
              name: profile,
              baseEnv: terminalEnv
            }, sessionID);
            toast(`New sessions will use "${profile}"`, "success");
          }
          if (choice === "reload") {
            const next = await call("reload", {
              sessionID,
              baseEnv: terminalEnv
            }, sessionID);
            toast(`Reloaded ${next.configPath}`, "success");
          }
          if (choice === "secret-store") {
            await showSecretStoreStatus(state.configPath);
          }
        } catch (error) {
          toastError("Environment action failed", error);
        }
      }
    }
    const unregisterSlot = context.ui.slot({
      append: "session.composer.top",
      render: (props) => {
        createEffect(on(() => props.sessionID, (sessionID) => {
          if (sessionID)
            ensureApplied(sessionID);
        }, {
          defer: false
        }));
        return null;
      }
    });
    const unsubscribeCreated = context.data.on("session.created", (event) => {
      const sessionID = event?.data?.sessionID;
      if (typeof sessionID === "string")
        ensureApplied(sessionID, event?.location);
    });
    const unsubscribeStarted = context.data.on("session.execution.started", (event) => {
      const sessionID = event?.data?.sessionID;
      if (typeof sessionID === "string")
        reapply(sessionID, event?.location);
    });
    context.keymap.layer(() => ({
      mode: "global",
      priority: 20,
      commands: [{
        id: "env.manager.menu",
        title: "Environment profiles",
        description: "View and manage environment profiles for this session",
        group: "Environment",
        palette: true,
        slash: {
          name: "env",
          aliases: ["envs"]
        },
        run: async () => {
          try {
            await openMenu();
          } catch (error) {
            toastError("Environment", error);
          }
        }
      }]
    }));
    const sessionID = currentSessionID();
    if (sessionID)
      ensureApplied(sessionID);
    return () => {
      unregisterSlot();
      unsubscribeCreated();
      unsubscribeStarted();
    };
  }
});
function snapshotEnvironment() {
  try {
    const environment = globalThis?.process?.env;
    if (!environment || typeof environment !== "object")
      return;
    const snapshot = {};
    for (const [key, value] of Object.entries(environment)) {
      if (typeof value === "string")
        snapshot[key] = value;
    }
    return snapshot;
  } catch {
    return;
  }
}
function messageOf(error) {
  if (error instanceof Error)
    return error.message;
  return String(error);
}
export {
  tui_default as default
};
