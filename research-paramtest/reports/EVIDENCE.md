# Evidence

## [S1] Pi Coding Agent

- URL: https://pi.dev/docs/latest/extensions
- Reachability: ok

- BM25 relevance score: 6.059

> builtin for built-in tools
> sdk for tools passed via createAgentSession({ customTools })
> extension source metadata for tools registered by extensions
> 
> pi.setModel(model)
>         
>         
>           
>           
>           Copied
>         
>         
> Set the current model. Returns false if no API key is available for the model. See models.md for configuring custom models.
> const "claude-sonnet-4-5");
> if (model) {
>   const pi.setModel(model);
>   if (!success) {
>     ctx.ui.notify("No API key for this model", "error");
>   }
> }
> 
> pi.getThinkingLevel() / pi.setThinkingLevel(level)
>         
>         
>           
>           
>           Copied
>         
>         
> Get or set the thinking level. Level is clamped to mode

## [S2] Extensions

- URL: https://pi.ubitools.com/extensions/
- Reachability: ok

- BM25 relevance score: 6.856

> builtin for built-in tools
> sdk for tools passed via createAgentSession({ customTools })
> extension source metadata for tools registered by extensions
> 
> pi.setModel(model)Section titled “pi.setModel(model)”
> Set the current model. Returns false if no API key is available for the model. See models.md for configuring custom models.
> const model = ctx.modelRegistry.find("anthropic", "claude-sonnet-4-5");if (model) {const success = await pi.setModel(model);if (!success) {ctx.ui.notify("No API key for this model", "error");}}
> pi.getThinkingLevel() / pi.setThinkingLevel(level)Section titled “pi.getThinkingLevel() / pi.setThinkingLevel(level)”
> Get or set the thinking level. Level is clamped to model cap

## [S3] Extensions - pi

- URL: https://hochej.github.io/pi-mono/coding-agent/extensions/
- Reachability: ok
- Section: Extension's read tool replaces built-in read
- BM25 relevance score: 6.019

> Important: Use StringEnum from @mariozechner/pi-ai for string enums. Type.Union/Type.Literal doesn't work with Google's API.
> Overriding Built-in Tools¶
> Extensions can override built-in tools (read, bash, edit, write, grep, find, ls) by registering a tool with the same name. Interactive mode displays a warning when this happens.
> # Extension's read tool replaces built-in read
> pi-e./tool-override.ts
> 
> Alternatively, use --no-tools to start without any built-in tools:
> # No built-in tools, only extension tools
> pi--no-tools-e./my-extension.ts

## [S4] Extensions | Pi

- URL: https://pidocs.seepine.com/en/extensions
- Reachability: ok

- BM25 relevance score: 6.069

> Returns false if no API key is available for the model. See models.md for configuring custom models.const model = ctx.modelRegistry.find('anthropic', 'claude-sonnet-4-5')
> if (model) {
>   const success = await pi.setModel(model)
>   if (!success) {
>     ctx.ui.notify('No API key for this model', 'error')
>   }
> }
> pi.getThinkingLevel() / pi.setThinkingLevel(level)Get or set the thinking level. Level is clamped to model capabilities (non-reasoning models always use "off"). Changes emit thinking_level_select.const current = pi.getThinkingLevel() // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
> pi.setThinkingLevel('high')
> pi.eventsShared event bus for communication between extensions:pi.events
