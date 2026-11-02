# @curbi/vercel

Check completed AI SDK replies against explicit Curbi rules before your application receives the text.

```sh
npm install @curbi/vercel ai
```

With your existing `model` and a policy such as `{prices:[{item:'Pro',amount:49}]}`:

```js
import { wrapLanguageModel } from 'ai';
import { curbiMiddleware } from '@curbi/vercel';
const checkedModel = wrapLanguageModel({ model, middleware: curbiMiddleware({ policy }) });
```

Use `checkedModel` with `generateText`. A finding throws `CurbiCheckError`; its `findings` contain rule names and exact original spans. Transport errors, invalid verdicts and timeouts also throw. A passing reply preserves the provider result and adds `providerMetadata.curbi`.

`apiKey` is optional for public access. Managed access uses `curbiMiddleware({policy,apiKey:process.env.CURBI_API_KEY})`. `record` is optional caller-supplied evidence. Configuration is copied when the middleware is created. The timeout defaults to 15 seconds, with no automatic retries.

This package sends the policy, completed reply and optional record to `https://api.curbi.io/v1/check`. Each nonempty completed text result uses one HTTP request. Managed requests are subject to Curbi's published pricing and limits. Nothing in this package trains or calls a second language model; your original model still runs normally.

Streaming and alternate `structuredOutputText` are deliberately unsupported and fail closed. Empty policies are refused. This is reply auditing, not tool execution authorization, a universal firewall, provider reconciliation or cryptographic receipt verification. A pass means no configured rule fired. Caller records are not independent provider proof. Tool calls and side effects require their own enforcement.

Tested with AI SDK 7.0.159, including its real `wrapLanguageModel` and `generateText` interfaces. Runtime: Node 22+. MIT.

The response must explicitly report `proof.authorizationGranted: false`; missing or contradictory authority metadata is rejected. A passing check never grants execution authority.
