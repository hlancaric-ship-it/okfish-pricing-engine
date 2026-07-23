export class CsvParserStream extends TransformStream<Uint8Array, any> {
    constructor(delimiter: string = ';', quoteChar: string = '"') {
        let buffer = '';
        let headers: string[] | null = null;
        let inQuotes = false;
        let row: string[] = [];
        let pendingQuote = false;
        let pendingCr = false;
        const delimiterCode = delimiter.charCodeAt(0);
        const quoteCode = quoteChar.charCodeAt(0);
        const decoder = new TextDecoder();
        // Create regex once!
        const doubleQuoteRegex = new RegExp(quoteChar + quoteChar, 'g');

        super({
            transform(chunk, controller) {
                const decoded = decoder.decode(chunk, { stream: true });
                const str = buffer + decoded;
                let start = 0;
                let i = buffer.length;

                // Handle pending quote from previous chunk
                if (pendingQuote) {
                    if (decoded.length > 0 && decoded.charCodeAt(0) === quoteCode) {
                        i = buffer.length + 1; // Skip the escaped quote
                    } else {
                        inQuotes = !inQuotes;
                    }
                    pendingQuote = false;
                }

                // Handle pending CR from previous chunk
                if (pendingCr) {
                    pendingCr = false;
                    if (decoded.length > 0 && decoded.charCodeAt(0) === 10) {
                        i = buffer.length + 1; // skip \n since we already processed \r
                        start = buffer.length + 1;
                    }
                }

                for (; i < str.length; i++) {
                    const charCode = str.charCodeAt(i);

                    if (charCode === quoteCode) {
                        if (inQuotes) {
                            if (i + 1 < str.length) {
                                if (str.charCodeAt(i + 1) === quoteCode) {
                                    i++; // skip escaped quote
                                } else {
                                    inQuotes = !inQuotes;
                                }
                            } else {
                                pendingQuote = true;
                            }
                        } else {
                            inQuotes = !inQuotes;
                        }
                    } else if (charCode === delimiterCode && !inQuotes) {
                        // Extract value
                        let val = str.substring(start, i);
                        if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                            val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                        }
                        row.push(val);
                        start = i + 1;
                    } else if (charCode === 13 && !inQuotes) { // \r
                        let val = str.substring(start, i);
                        if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                            val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                        }
                        
                        if (i + 1 < str.length) {
                            if (str.charCodeAt(i + 1) === 10) { // \n
                                i++; // skip \n
                            }
                        } else {
                            pendingCr = true;
                        }
                        row.push(val);
                        if (!headers) {
                            headers = row;
                        } else {
                            const obj: Record<string, string> = {};
                            for (let j = 0; j < headers.length; j++) {
                                obj[headers[j]] = row[j] || '';
                            }
                            controller.enqueue(obj);
                        }
                        row = [];
                        start = i + 1;
                    } else if (charCode === 10 && !inQuotes) { // \n
                        let val = str.substring(start, i);
                        if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                            val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                        }
                        
                        row.push(val);
                        if (!headers) {
                            headers = row;
                        } else {
                            const obj: Record<string, string> = {};
                            for (let j = 0; j < headers.length; j++) {
                                obj[headers[j]] = row[j] || '';
                            }
                            controller.enqueue(obj);
                        }
                        row = [];
                        start = i + 1;
                    }
                }

                buffer = str.substring(start);
            },
            flush(controller) {
                const str = buffer + decoder.decode(); // flush remaining
                // If there's a pending quote and no more string, it means the file ends with a quote.
                if (pendingQuote) {
                    inQuotes = !inQuotes;
                }
                
                let start = 0;
                let i = 0;
                for (; i < str.length; i++) {
                    const charCode = str.charCodeAt(i);
                    if (charCode === quoteCode) {
                        if (inQuotes && i + 1 < str.length && str.charCodeAt(i + 1) === quoteCode) {
                            i++;
                        } else {
                            inQuotes = !inQuotes;
                        }
                    } else if (charCode === delimiterCode && !inQuotes) {
                        let val = str.substring(start, i);
                        if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                            val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                        }
                        row.push(val);
                        start = i + 1;
                    } else if ((charCode === 10 || charCode === 13) && !inQuotes) {
                        if (charCode === 13 && i + 1 < str.length && str.charCodeAt(i + 1) === 10) {
                            i++;
                        }
                        let val = str.substring(start, i);
                        if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                            val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                        }
                        row.push(val);
                        if (!headers) headers = row;
                        else {
                            const obj: Record<string, string> = {};
                            for (let j = 0; j < headers.length; j++) obj[headers[j]] = row[j] || '';
                            controller.enqueue(obj);
                        }
                        row = [];
                        start = i + 1;
                    }
                }
                
                if (start < str.length) {
                    let val = str.substring(start);
                    if (val.charCodeAt(0) === quoteCode && val.charCodeAt(val.length - 1) === quoteCode && val.length >= 2) {
                        val = val.substring(1, val.length - 1).replace(doubleQuoteRegex, quoteChar);
                    }
                    row.push(val);
                }
                
                if (row.length > 0 && headers) {
                    const obj: Record<string, string> = {};
                    for (let j = 0; j < headers.length; j++) obj[headers[j]] = row[j] || '';
                    controller.enqueue(obj);
                }
            }
        });
    }
}
