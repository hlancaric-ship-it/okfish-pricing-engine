export class FeedVerifier {
    csvRows: number = 0;
    xmlProducts: number = 0;

    async verify(xmlString: string) {
        // Just a simple count of <SHOPITEM> to be fast
        const matches = xmlString.match(/<SHOPITEM>/g);
        if (matches) {
            this.xmlProducts += matches.length;
        }
    }

    getReport() {
        return {
            csvProducts: this.csvRows,
            xmlProducts: this.xmlProducts,
            match: this.csvRows === this.xmlProducts
        };
    }
}
