Starting points for a new `.test.svelte` file.

1. Copy the template next to the component you want to test and rename it to `<YourComponent>.test.svelte` (dropping the `.template` suffix).
2. Replace `<path>` with the location of `sweater-vest-suede`, `<component>` with the component under test, and `<test name>` with a description of what the test asserts.

Use [ComponentWithModel.test.svelte.template](./ComponentWithModel.test.svelte.template) when the component is driven by a model instance; use [Component.test.svelte.template](./Component.test.svelte.template) otherwise.

The `.template` suffix keeps these files out of the `*.test.svelte` glob that discovers your tests — a copy is only picked up once you rename it.
