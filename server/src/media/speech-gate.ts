// stand-in: replaced by the actions slice at integration
/** Request-scoped speech gate (T20). Media only cancels speech when a listener's live session ends. */
import type { ListenerId } from '@sanctum/contracts';
import { Context } from 'effect';

export class SpeechGate extends Context.Tag('sanctum/SpeechGate')<
  SpeechGate,
  { readonly cancel: (listener_id: ListenerId, reason: string) => void }
>() { }
