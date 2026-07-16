/**
 * Type stubs for @elizaos/core — used during build.
 * The actual types are provided by the user's project at runtime via peerDependencies.
 */

declare module '@elizaos/core' {
  export type UUID = `${string}-${string}-${string}-${string}-${string}`;

  export interface Content {
    text: string;
    action?: string;
    source?: string;
    url?: string;
    inReplyTo?: UUID;
    attachments?: unknown[];
    [key: string]: unknown;
  }

  export interface Memory {
    id?: UUID;
    userId: UUID;
    agentId: UUID;
    content: Content;
    roomId: UUID;
    createdAt?: number;
    embedding?: number[];
  }

  export interface State {
    userId?: UUID;
    agentId?: UUID;
    bio: string;
    lore: string;
    messageDirections: string;
    postDirections: string;
    roomId?: UUID;
    actors: string;
    actorsData: unknown[];
    goals: string;
    goalsData: unknown[];
    recentMessages: string;
    recentMessagesData: Memory[];
    actions: string;
    actionsData?: Action[];
    providers: string;
    [key: string]: unknown;
  }

  export interface ActionExample {
    user: string;
    content: Content;
  }

  export type HandlerCallback = (response: Content, files?: unknown) => Promise<Memory[]>;

  export type Handler = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ) => Promise<unknown>;

  export type Validator = (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ) => Promise<boolean>;

  export interface Action {
    name: string;
    description: string;
    similes: string[];
    examples: ActionExample[][];
    handler: Handler;
    validate: Validator;
    suppressInitialMessage?: boolean;
  }

  export interface Provider {
    name?: string;
    description?: string;
    get: (runtime: IAgentRuntime, message: Memory, state?: State) => Promise<unknown>;
  }

  export interface Evaluator {
    name: string;
    description: string;
    similes: string[];
    examples: unknown[];
    handler: Handler;
    validate: Validator;
    alwaysRun?: boolean;
  }

  export interface Plugin {
    name: string;
    description: string;
    npmName?: string;
    config?: { [key: string]: unknown };
    actions?: Action[];
    providers?: Provider[];
    evaluators?: Evaluator[];
    services?: unknown[];
    clients?: unknown[];
    adapters?: unknown[];
    handlePostCharacterLoaded?: (char: unknown) => Promise<unknown>;
    init?: (runtime: IAgentRuntime) => void;
  }

  export interface IAgentRuntime {
    agentId: UUID;
    character: unknown;
    messageManager: unknown;
    descriptionManager: unknown;
    serverUrl: string;
    token: string | null;
    [key: string]: unknown;
  }
}
