// Hand-written fictional statements; never derived from bank or personal data.
export const sgmlHeader =
  "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nSECURITY:NONE\nENCODING:USASCII\nCHARSET:1252\nCOMPRESSION:NONE\nOLDFILEUID:NONE\nNEWFILEUID:NONE\n\n";
export function ofxRow({
  id = "fixture-1",
  amount = "-120.00",
  date = "20261002120000[-3:PYT]",
  payee = "Fixture shop",
} = {}) {
  return `<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>${date}</DTPOSTED><TRNAMT>${amount}</TRNAMT><FITID>${id}</FITID><NAME>${payee}</NAME></STMTTRN>`;
}
export function ofx(
  rows = ofxRow(),
  {
    sgml = false,
    currency = "PYG",
    account = "fixture-account",
    period = "",
  } = {},
) {
  let body = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>${currency}</CURDEF><BANKACCTFROM><BANKID>fixture-bank</BANKID><ACCTID>${account}</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST>${period}${rows}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
  if (sgml)
    body = body.replace(
      /<\/(TRNTYPE|DTPOSTED|TRNAMT|FITID|NAME|CURDEF|BANKID|ACCTID|ACCTTYPE|DTSTART|DTEND)>/g,
      "",
    );
  return sgml
    ? sgmlHeader + body
    : '<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="220"?>' +
        body;
}
export function camtRow({
  id = "fixture-1",
  ref = "entry-1",
  amount = "120.00",
  sign = "DBIT",
  date = "<Dt>2026-10-02</Dt>",
  payee = "<AddtlNtryInf>Fixture shop</AddtlNtryInf>",
  currency = "PYG",
  status = "<Sts><Cd>BOOK</Cd></Sts>",
} = {}) {
  return `<Ntry><NtryRef>${ref}</NtryRef>${status}<Amt Ccy="${currency}">${amount}</Amt><CdtDbtInd>${sign}</CdtDbtInd><BookgDt>${date}</BookgDt><AcctSvcrRef>${id}</AcctSvcrRef>${payee}</Ntry>`;
}
export function camt(rows = camtRow(), { currency = "PYG", period = "" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>fixture-statement</Id>${period}<Acct><Id><IBAN>FICTIONAL-ACCOUNT</IBAN></Id><Ccy>${currency}</Ccy></Acct>${rows}</Stmt></BkToCstmrStmt></Document>`;
}
