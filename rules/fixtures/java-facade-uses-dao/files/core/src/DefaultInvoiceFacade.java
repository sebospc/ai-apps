package com.acme.facades.impl;

public class DefaultInvoiceFacade implements InvoiceFacade
{
    private InvoiceDao invoiceDao;

    @Override
    public List<InvoiceData> getInvoicesForUnit(final String unitCode)
    {
        final List<InvoiceModel> invoices = invoiceDao.findByUnitCode(unitCode);
        return invoiceConverter.convertAll(invoices);
    }
}
