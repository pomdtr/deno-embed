# Smallweb Embed

This package provide a simple way to embed assets in your smallweb application.

## Usage

Use the cli to embed assets in your app:

```sh
deno run -A jsr:@smallweb/embed frontend/dist dist
```

Then, from your app, you can import the assets from the generated module:

```ts
import embeds from "./dist/mod.ts";

// serve the static assets from the frontend/dist directory
function handler(req: Request) {
    return embeds.serve(req);
}

export default {
    fetch: handler,
}
```

## TODO

- ETag support
