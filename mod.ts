import * as path from "jsr:@std/path@1.0.0";
import { exists } from "jsr:@std/fs@1.0.0-rc.5";
import { encodeBase64 } from "jsr:@std/encoding@1.0.1/base64";
import { Command } from "jsr:@cliffy/command@1.0.0-rc.5";
import manifest from "./deno.json" with { type: "json" };

/** Read all files from a directory tree, recursively.  */
async function* recursiveReadDir(
    dir: string,
): AsyncGenerator<Deno.DirEntry> {
    for await (const entry of Deno.readDir(dir)) {
        if (entry.isSymlink) {
            console.warn(`Symlinks are unsupported: ${entry.name}`);
            continue;
        }
        if (entry.isFile) {
            yield entry;
            continue;
        }
        // entry.isDirectory
        const dirName = entry.name;
        for await (const child of recursiveReadDir(path.join(dir, dirName))) {
            yield {
                ...child,
                name: path.join(dirName, child.name),
            };
        }
    }
}

/**
 * Configures a mapping from an input "source" dir, to an output destination.
 */
export interface Mapping {
    /** A directory containing your static files. */
    sourceDir: string;

    /**
     * Where to store the embedded files.
     *
     * Note: Each input directory should store its output in a separate,
     * non-overlapping directory.
     */
    destDir: string;
}

// Can convert from one directory to another.
interface Converter {
    /** Do one convert */
    convert(): Promise<void>;

    /**
     * Clean up the output directory for a fresh generate.
     */
    clean(): Promise<void>;
}

/** Just converts static files, no plugins. */
class StaticConverter implements Converter {
    #sourceDir: string;
    #destDir: string;
    #embedWriter: EmbedWriter;

    constructor(sourceDir: string, destDir: string) {
        this.#sourceDir = sourceDir;
        this.#destDir = destDir;
        this.#embedWriter = new EmbedWriter(destDir);
    }

    async convert(): Promise<void> {
        // TODO: Could we do this atomically, in a tempdir, then move it into place?
        // Or would that mess up `deno run --watch`?

        await this.#embedWriter.clean();
        await this.#mkdirs();

        for await (const entry of recursiveReadDir(this.#sourceDir)) {
            await this.#convertFile(entry.name);
        }

        await this.#embedWriter.writeDir();
    }

    async #convertFile(relPath: string) {
        const fullPath = path.join(this.#sourceDir, relPath);
        await this.#embedWriter.writeFile({
            filePath: relPath,
            data: await Deno.readFile(fullPath),
        });
    }

    async #mkdirs() {
        await Deno.mkdir(this.#destDir, { recursive: true });
    }

    async clean(): Promise<void> {
        await this.#embedWriter.clean();
    }
}

/**
 * Class that just writes embedded files to a directory.
 */
class EmbedWriter {
    minCompressionGainBytes = 200;

    constructor(readonly destDir: string) {
        if (!path.isAbsolute(destDir)) {
            throw new Error(`destDir must be absolute: ${destDir}`);
        }
    }

    async writeFile(
        { filePath, data }: { filePath: string; data: Uint8Array },
    ): Promise<void> {
        const compression = "gzip";
        const compressed = await compress(data, compression);
        const gain = data.length - compressed.length;
        const shouldCompress = gain >= this.minCompressionGainBytes;

        let encoded = shouldCompress
            ? encodeBase64(compressed)
            : encodeBase64(data);
        encoded = encoded.replaceAll(/.{120}/g, (it) => it + "\n");

        const { onDisk: outPath } = this.#addFile(filePath);

        const outLines = [
            `export default {`,
            ` size: ${data.length},`,
        ];

        if (shouldCompress) {
            outLines.push(` compression: "${compression}",`);
        }
        outLines.push(` encoded: \`\n${encoded}\`,`);
        outLines.push(`}`);
        const outData = outLines.join("\n");

        await Deno.mkdir(path.dirname(outPath), { recursive: true });
        await Deno.writeTextFile(outPath, outData);
    }

    /**
     * Add a file to our internal list of files in this dir.
     *
     * Returns an object w/ normalized/non-normalized paths.
     */
    #addFile(filePath: string): FilePaths {
        const absPath = path.resolve(this.destDir, filePath);
        if (!parentChild(this.destDir, absPath)) {
            // Don't allow Plugin authors to emit to, say, ../someOtherFile.ts:
            throw new Error(`${absPath} must be within ${this.destDir}`);
        }
        const relative = toPosix(path.relative(this.destDir, absPath));

        // Spaces aren't allowed on JSR:
        let normalized = relative.replaceAll(/[ ]+/g, "_");
        // .d.ts *anywhere* in the file name invokes special typescript behavior:
        normalized = normalized.replaceAll(".d.ts", ".d_ts");
        const { base, dir } = path.parse(normalized);
        // Prefix generated files with _ so they sorts together nicely. (makes dir.ts easy to see.)
        normalized = path.join(dir, `_${base}.ts`);

        const onDisk = path.join(this.destDir, normalized);
        const importPath = "./" + normalized;

        const paths: FilePaths = {
            original: filePath,
            relative,
            import: importPath,
            onDisk,
        };

        const existing = this.#files.get(paths.onDisk);
        if (existing) {
            const msg = [
                `Two files normalize to the same on-disk location: "${paths.onDisk}":`,
                `1) "${existing.original}"`,
                `2) "${paths.original}"`,
            ].join("\n");
            throw new Error(msg);
        }
        this.#files.set(paths.onDisk, paths);

        return paths;
    }

    /** Files we've written, keyed by .onDisk */
    #files = new Map<string, FilePaths>();

    /**
     * write the dir.ts file that lets us find all files.
     *
     * You should call this after you've written all your files.
     */
    async writeDir(): Promise<void> {
        // Files, sorted by the relative path, for output stability:
        const files = [...this.#files.values()].sort(
            byKey((it) => it.relative),
        );

        const body = [
            `import { FileServer, Embeds } from "jsr:@smallweb/embed@${manifest.version}/file-server";`,
            "",
            `const embeds = new Embeds({`,
        ];
        files.forEach((file) => {
            body.push(
                `  "${file.relative}": () => import("${file.import}"),`,
            );
        });

        body.push(`});`);

        body.push("");
        body.push("const server = new FileServer(embeds);");
        body.push("export const serveDir = server.serveDir");
        body.push("export default embeds;");

        const outPath = path.join(this.destDir, "dir.ts");
        await Deno.writeTextFile(outPath, body.join("\n"));

        // Also mark these files as generated for git/github:
        await Deno.writeTextFile(
            path.join(this.destDir, ".gitattributes"),
            `* linguist-generated=true`,
        );
    }

    /**
     * Delete all generated files. Run before a regenerate to start fresh.
     */
    async clean() {
        this.#files.clear();

        if (!await exists(this.destDir) || await isEmptyDir(this.destDir)) {
            // No dir to clean up. Probably because this is our first run:
            return;
        }

        await Deno.remove(this.destDir, { recursive: true });
    }
}

async function isEmptyDir(path: string) {
    for await (const _entry of Deno.readDir(path)) {
        return false;
    }
    return true;
}

/** Used with Array.sort to sort elements by some key. */
function byKey<T, K extends number | string>(keyFn: KeyFn<T, K>): CmpFn<T> {
    return function cmpFn(aT, aB) {
        const a = keyFn(aT);
        const b = keyFn(aB);
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    };
}

type KeyFn<T, K> = (t: T) => K;
type CmpFn<T> = (a: T, b: T) => number;

type FilePaths = {
    /** The import path given to us by the {@link Plugin}. */
    // Just used for error messages, to show the invalid input(s).
    original: string;

    /** Relative file path within dest dir, in POSIX file path format (using /, not \).
     *
     * ex: `foo/bar.png`
     */
    relative: string;

    /** The full path to the generated file on disk. */
    onDisk: string;

    /** The relative import for the embedded file. ex: "./foo/_bar.png.ts" */
    import: string;
};

const toPosix = (() => {
    let toPosix = (p: string) => p;
    if (path.SEPARATOR === "\\") {
        toPosix = (p) => p.replaceAll("\\", "/");
    }
    return toPosix;
})();

type CompressionFormat = ConstructorParameters<typeof CompressionStream>[0];

async function compress(
    data: Uint8Array,
    compression: CompressionFormat,
): Promise<Uint8Array> {
    const input = new Blob([data]);
    const cs = new CompressionStream(compression);
    const stream = input.stream().pipeThrough(cs);

    const outParts: Uint8Array[] = [];
    const writer = new WritableStream<Uint8Array>({
        write(chunk) {
            outParts.push(chunk);
        },
    });

    await stream.pipeTo(writer);

    const buf = await new Blob(outParts).arrayBuffer();
    return new Uint8Array(buf);
}

// TODO: Is there not a built-in that does this?
function parentChild(parent: string, child: string): boolean {
    parent = path.normalize(parent);
    child = path.normalize(child);

    if (!path.isAbsolute(parent)) {
        throw new Error(`Parent path must be absolute`);
    }
    if (!path.isAbsolute(child)) {
        throw new Error(`Child path must be absolute`);
    }

    if (parent.length >= child.length) {
        return false;
    }

    while (child.length > parent.length) {
        child = path.dirname(child);
    }

    return child === parent;
}

export async function embedDir(src: string, dst: string) {
    const baseDir = Deno.cwd();

    const sourceDir = path.resolve(baseDir, src);
    const destDir = path.resolve(baseDir, dst);

    const converter = new StaticConverter(sourceDir, destDir);

    await converter.clean();
    await converter.convert();
}

if (import.meta.main) {
    const mainCommand = new Command()
        .name("deno-embedder")
        .version(manifest.version)
        .description("Embeds static files into TypeScript.")
        .arguments("<src:string> <dest:string>")
        .action(async (_, src, dst) => {
            console.log("Converting files...");
            await embedDir(src, dst);
            console.log("Done");
        });

    await mainCommand.parse(Deno.args);
}
