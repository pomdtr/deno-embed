import { decodeBase64 } from "jsr:@std/encoding@1.0.1/base64";
import { serveDir, type ServeDirOptions } from "./file_server.ts";

const decoder = new TextDecoder();

/**
 * Represents the contents of a file that's been embedded into TypeScript.
 */
export class File {
    /** Size of the embedded file in bytes (uncomrpessed/unencoded) */
    readonly size: number;

    /** May be compressed */
    #contents: {
        bytes: Uint8Array;
        compression: CompressionFormat | undefined;
    };

    /** Called (indirectly) by each embedded file. */
    constructor(meta: FileMeta) {
        this.size = meta.size;
        // We now use dynamic imports, so we're specifically importing this file due to a request.
        // Eagerly decode base64 into bytes so we can GC the inefficient encoding.
        this.#contents = {
            bytes: decodeBase64(meta.encoded),
            compression: meta.compression,
        };
    }

    /** Returns the raw bytes of the embedded file. */
    async bytes(): Promise<Uint8Array> {
        let { bytes, compression } = this.#contents;

        // Decompress on first use:
        if (compression) {
            bytes = await decompress(bytes, compression);
            compression = undefined;
            this.#contents = { bytes, compression };
        }

        return bytes;
    }

    /**
     * Parse the bytes as utf-8 text.
     */
    async text(): Promise<string> {
        if (this.#cachedText === undefined) {
            this.#cachedText = decoder.decode(await this.bytes());
        }
        return this.#cachedText;
    }
    #cachedText: undefined | string = undefined;
}

/**
 * The data we expect to find generated embedded files.
 */
export interface FileMeta {
    /** Size of the embedded file (uncomrpessed/unencoded) */
    size: number;

    /**
     * The base-64 encoded representation of the file.
     *
     * Note: One benefit of passing this to a TypeScript function/object is that
     * we can immediately decode it, and save on 33% of the base64 encoding cost
     * in memory. (after GC)
     */
    encoded: string;

    /** If specified, how the bytes of this file are compressed. */
    compression?: CompressionFormat;
    eTag: string;
    atime?: Date;
    mtime?: Date;

    // TODO: sha256, modified time, etc.
}

/** Valid compression formats for embedded files. */
type CompressionFormat = ConstructorParameters<
    typeof DecompressionStream
>[0];

async function decompress(
    data: Uint8Array,
    compression: CompressionFormat,
): Promise<Uint8Array> {
    const input = new Blob([data]);
    const ds = new DecompressionStream(compression);
    const stream = input.stream().pipeThrough(ds);

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

type FileModule = { default: FileMeta };

/** A function that we can call to import a file module. */
type FileImporter = () => Promise<FileModule>;

/** We expect the embed file to pass this into Embeds. */
type EmbedsDef<K extends string> = Record<K, FileImporter>;

/**
 * Allows accessing all files embedded.
 */
export class Embeds<K extends string = string> {
    #embeds: EmbedsDef<K>;

    /**
     * Called (indirectly) by a \`mod.ts\` file to register its contents.
     */
    constructor(embeds: EmbedsDef<K>) {
        this.#embeds = embeds;
    }

    /**
     * Returns a list of embed file keys.
     *
     * This method can be used to retrieve the keys of the embed files for
     * iteration or other purposes.
     */
    list(): Array<K> {
        return Object.keys(this.#embeds) as Array<K>;
    }

    /**
     * Type-safe method to load a known embed file.
     *
     * If you know you need a particular embed at compile time, using this method
     * lets TypeScript check that you have specified a correct (existing) file
     * path.
     */
    async load(filePath: K): Promise<File> {
        const importer = this.#embeds[filePath];
        const mod = await importer();
        return new File(mod.default);
    }

    async stat(filePath: K): Promise<FileMeta | null> {
        const importer = this.#embeds[filePath];
        if (!importer) return null;
        const mod = await importer();
        return mod.default;
    }

    /**
     * Method to do runtime loading of a file.
     *
     * If you're loading user-specified file paths, use this method. It will
     * return \`null\` if no such file exists.
     */
    async get(filePath: string): Promise<File | null> {
        const importer = this.#embeds[filePath as K];
        if (!importer) return null;

        const mod = await importer();
        return new File(mod.default);
    }

    serve(req: Request, options?: ServeDirOptions): Promise<Response> {
        return serveDir(this, req, options);
    }
}
