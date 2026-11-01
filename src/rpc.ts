import { Rpc } from "@opencode/plugin/rpc"

const string = { type: "string" } as const
const stringMap = { type: "object", additionalProperties: { type: "string" } } as const
const result = { type: "object", additionalProperties: true } as const

const sessionInput = {
  type: "object",
  properties: {
    sessionID: string,
    baseEnv: stringMap,
  },
  additionalProperties: false,
} as const

const sessionProfileInput = {
  type: "object",
  properties: {
    sessionID: string,
    profile: string,
    baseEnv: stringMap,
  },
  required: ["sessionID", "profile"],
  additionalProperties: false,
} as const

const sessionKeyInput = {
  type: "object",
  properties: {
    sessionID: string,
    key: string,
    baseEnv: stringMap,
  },
  required: ["sessionID", "key"],
  additionalProperties: false,
} as const

const sessionValueInput = {
  type: "object",
  properties: {
    sessionID: string,
    key: string,
    value: string,
    baseEnv: stringMap,
  },
  required: ["sessionID", "key", "value"],
  additionalProperties: false,
} as const

const profileNameInput = {
  type: "object",
  properties: {
    profile: string,
    baseEnv: stringMap,
  },
  required: ["profile"],
  additionalProperties: false,
} as const

const definition = Rpc.define({
  id: "env.manager",
  events: {},
  methods: {
    state: { input: sessionInput, output: result },
    resolve: { input: sessionInput, output: result },
    activeProfile: {
      input: {
        type: "object",
        properties: { sessionID: string },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { profile: string, defaultProfile: string },
        required: ["profile"],
        additionalProperties: false,
      },
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
        additionalProperties: false,
      },
      output: result,
    },
    copyProfile: {
      input: {
        type: "object",
        properties: { from: string, to: string, baseEnv: stringMap },
        required: ["from", "to"],
        additionalProperties: false,
      },
      output: result,
    },
    renameProfile: {
      input: {
        type: "object",
        properties: { from: string, to: string, baseEnv: stringMap },
        required: ["from", "to"],
        additionalProperties: false,
      },
      output: result,
    },
    deleteProfile: {
      input: {
        type: "object",
        properties: { name: string, baseEnv: stringMap },
        required: ["name"],
        additionalProperties: false,
      },
      output: result,
    },
    setVariable: {
      input: {
        type: "object",
        properties: { profile: string, key: string, value: string, baseEnv: stringMap },
        required: ["profile", "key", "value"],
        additionalProperties: false,
      },
      output: result,
    },
    removeVariable: {
      input: {
        type: "object",
        properties: { profile: string, key: string, baseEnv: stringMap },
        required: ["profile", "key"],
        additionalProperties: false,
      },
      output: result,
    },
    setSecret: {
      input: {
        type: "object",
        properties: { profile: string, name: string, entry: string, baseEnv: stringMap },
        required: ["profile", "name", "entry"],
        additionalProperties: false,
      },
      output: result,
    },
    removeSecret: {
      input: {
        type: "object",
        properties: { profile: string, name: string, baseEnv: stringMap },
        required: ["profile", "name"],
        additionalProperties: false,
      },
      output: result,
    },
    vaultStatus: {
      input: {
        type: "object",
        properties: { baseEnv: stringMap },
        additionalProperties: false,
      },
      output: result,
    },
    vaultGet: {
      input: {
        type: "object",
        properties: {
          entries: { type: "array", items: string, maxItems: 64 },
        },
        required: ["entries"],
        additionalProperties: false,
      },
      output: result,
    },
    addEnvFile: {
      input: {
        type: "object",
        properties: { profile: string, path: string, baseEnv: stringMap },
        required: ["profile", "path"],
        additionalProperties: false,
      },
      output: result,
    },
    removeEnvFile: {
      input: {
        type: "object",
        properties: { profile: string, path: string, baseEnv: stringMap },
        required: ["profile", "path"],
        additionalProperties: false,
      },
      output: result,
    },
    clearEnvFiles: { input: profileNameInput, output: result },
    setDefaultProfile: {
      input: {
        type: "object",
        properties: { name: string, baseEnv: stringMap },
        required: ["name"],
        additionalProperties: false,
      },
      output: result,
    },
    reload: { input: sessionInput, output: result },
  },
})

// JSON Schema definitions are portable at runtime, but `Rpc.define` types them
// as codecs. The client helper only needs the portable shape.
export const EnvManager = definition as unknown as Rpc.PortableDefinition
