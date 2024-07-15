import embeds from "./dist/mod.ts";

export default {
    fetch: (req: Request) => {
        return embeds.serve(req);
    },
};
