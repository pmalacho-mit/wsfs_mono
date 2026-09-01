<script lang="ts" module>
  import { type Output, accessor, is } from "./output";

  /**
   * Just putting HTML with script tags on the DOM will not get them evaluated.
   * Using this hack we execute them anyway.
   * @param element
   */
  const evalScriptTagsHack = (element: Element) =>
    element
      .querySelectorAll('script[type|="text/javascript"]')
      .forEach(function (e) {
        if (e.textContent !== null) eval(e.textContent);
      });

  export const output = {
    unrecognized,
    stream,
    displayData,
    executeResult,
    errorResult,
    any,
  };
</script>

{#snippet unrecognized(identifier: string | Output.Any, detail: string)}
  <div>
    Unrecognized {typeof identifier === "string"
      ? identifier
      : identifier.output_type} ({detail}). Please contact the Pytutor
    maintainers and/or your professor.
  </div>
{/snippet}

{#snippet stream(output: Output.Stream)}
  {@const access = accessor(output)}
  {@const text = access.out ?? access.err}

  {#if Array.isArray(text)}
    {#each text as line}
      {@render row(line)}
    {/each}
  {:else if typeof text === "string"}
    {@render row(text)}
  {:else}
    {@render unrecognized("stream", JSON.stringify(typeof text))}
  {/if}

  {#snippet row(line: string)}
    <div style:white-space="pre-line">
      {line}
    </div>
  {/snippet}
{/snippet}

{#snippet displayData(output: Output.DisplayData)}
  {@const access = accessor(output)}
  {#if access.image}
    <img src={access.image} alt="display output" />
  {:else}
    {@render unrecognized(output, JSON.stringify(Object.keys(output.data)))}
  {/if}
{/snippet}

{#snippet executeResult(output: Output.ExecuteResult)}
  {@const access = accessor(output)}
  {#if access.html}
    <div {@attach evalScriptTagsHack}>
      {@html access.html}
    </div>
  {:else if access.plain}
    <div style:white-space="pre-line">
      {access.plain}
    </div>
  {:else}
    {@render unrecognized(output, JSON.stringify(Object.keys(output.data)))}
  {/if}
{/snippet}

{#snippet errorResult(output: Output.Error)}
  <strong>{output.ename}: {output.evalue}</strong>
  <pre>
    {#each output.traceback as line}
      {line}
    {/each}
  </pre>
{/snippet}

{#snippet any(output: Output.Any)}
  {#if is(output, "stream")}
    {@render stream(output)}
  {:else if is(output, "display_data")}
    {@render displayData(output)}
  {:else if is(output, "execute_result")}
    {@render executeResult(output)}
  {:else if is(output, "error")}
    {@render errorResult(output)}
  {:else}
    {@render unrecognized("output_type", output.output_type)}
  {/if}
{/snippet}
