// stand-in: replaced by the models slice at integration
import { Context } from 'effect';

/** Model client; the models slice supplies the service shape, `LlmLive` and `fixtureLlm`. */
export class LlmClient extends Context.Tag('sanctum/LlmClient')<LlmClient, unknown>() { }
