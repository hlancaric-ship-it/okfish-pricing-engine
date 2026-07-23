import { describe, it, expect } from 'vitest';
import { XMLValidator } from 'fast-xml-parser';
import { createRowToXmlTransform, createXmlWellFormednessValidator } from '../src/feed-generator';
import { CsvRow } from '../src/engine/pricing';

// E2E requirement: before publishing, run a REAL XML validation pass. If the feed is
// not well-formed, generation must FAIL (nothing is published). This is checked two ways:
//  1. Our own streaming validator (production-safe: never buffers the whole document,
//     runs inline in the same pipe as the R2 upload) — tested here directly.
//  2. Independently cross-checked against fast-xml-parser's XMLValidator, an established
//     third-party parser, on the fully assembled output (safe to do in a test, since tests
//     don't have the Worker's memory limit) — to confirm our own validator's notion of
//     "well-formed" agrees with a real, independent parser rather than just our own
//     assumptions.

function sampleRow(extra: CsvRow = {}): CsvRow {
    return {
        code: '97062',
        name: 'nastraha KEITECH & Spol. <VIP>',
        price: '6,25',
        purchasePrice: '4,00',
        standardPrice: '6,25',
        priceRatio: '1',
        actionPrice: '5,50',
        ...extra
    };
}

async function buildFullXml(rows: CsvRow[]): Promise<string> {
    const source = new ReadableStream<CsvRow>({
        start(controller) {
            for (const row of rows) controller.enqueue(row);
            controller.close();
        }
    });
    const chunks: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(chunk); }
    });
    await source.pipeThrough(createRowToXmlTransform(() => {})).pipeTo(sink);
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
}

async function runThroughValidator(xml: string): Promise<void> {
    const bytes = new TextEncoder().encode(xml);
    // Split into a few chunks to exercise the streaming/incremental parsing path,
    // not just a single whole-document call.
    const chunkSize = Math.max(1, Math.floor(bytes.length / 3));
    const source = new ReadableStream<Uint8Array>({
        start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize) {
                controller.enqueue(bytes.subarray(i, i + chunkSize));
            }
            controller.close();
        }
    });
    await source.pipeThrough(createXmlWellFormednessValidator()).pipeTo(new WritableStream());
}

describe('Real XML validation before publish', () => {
    it('a real generated feed passes our own streaming validator', async () => {
        const xml = await buildFullXml([sampleRow(), sampleRow({ code: '123' })]);
        await expect(runThroughValidator(xml)).resolves.toBeUndefined();
    });

    it('a real generated feed is independently confirmed well-formed by fast-xml-parser', async () => {
        const xml = await buildFullXml([sampleRow(), sampleRow({ code: '123' }), sampleRow({ code: '456', name: 'Ampersand & <angle>' })]);
        const result = XMLValidator.validate(xml);
        expect(result).toBe(true);
    });

    it('our streaming validator rejects a mismatched-tag document', async () => {
        const broken = '<?xml version="1.0"?>\n<SHOP><SHOPITEM><PRICELISTS></SHOPITEM></PRICELISTS></SHOP>';
        await expect(runThroughValidator(broken)).rejects.toThrow();
        expect(XMLValidator.validate(broken)).not.toBe(true); // agrees with the real parser
    });

    it('our streaming validator rejects an unclosed tag', async () => {
        const broken = '<?xml version="1.0"?>\n<SHOP><SHOPITEM><PRICELISTS></SHOP>';
        await expect(runThroughValidator(broken)).rejects.toThrow();
        expect(XMLValidator.validate(broken)).not.toBe(true);
    });

    it('our streaming validator rejects an unescaped bare "&" in content', async () => {
        const broken = '<?xml version="1.0"?>\n<SHOP><SHOPITEM><TITLE>Fish & Chips</TITLE></SHOPITEM></SHOP>';
        await expect(runThroughValidator(broken)).rejects.toThrow();
        expect(XMLValidator.validate(broken)).not.toBe(true);
    });

    it('our streaming validator rejects an unescaped bare ">" in content', async () => {
        const broken = '<?xml version="1.0"?>\n<SHOP><SHOPITEM><TITLE>5 > 3</TITLE></SHOPITEM></SHOP>';
        await expect(runThroughValidator(broken)).rejects.toThrow();
    });

    it('the full pipeline fails end-to-end (pipeTo rejects) on a validator-detected error, so nothing downstream ever sees a bad document', async () => {
        // Simulate the real pipeline shape: rows -> XML -> validator -> sink, and confirm
        // a failure anywhere upstream of the sink prevents the sink from ever completing.
        const rows: CsvRow[] = [sampleRow()];
        const source = new ReadableStream<CsvRow>({
            start(controller) {
                for (const row of rows) controller.enqueue(row);
                controller.close();
            }
        });
        let sinkClosed = false;
        const sink = new WritableStream<Uint8Array>({
            close() { sinkClosed = true; }
        });

        // Force a failure by feeding a transform that emits a deliberately broken tag.
        const encoder = new TextEncoder();
        const breakingTransform = new TransformStream<CsvRow, Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode('<?xml version="1.0"?>\n<SHOP><SHOPITEM><UNCLOSED>'));
            },
            transform() {},
            flush(controller) {
                controller.enqueue(encoder.encode('</SHOP>\n')); // never closes <SHOPITEM> or <UNCLOSED>
            }
        });

        await expect(
            source.pipeThrough(breakingTransform).pipeThrough(createXmlWellFormednessValidator()).pipeTo(sink)
        ).rejects.toThrow();
        expect(sinkClosed).toBe(false);
    });
});
