package com.acme.facades.impl;

import com.acme.core.dao.InvoiceDao;

public class DefaultInvoiceReportFacade implements InvoiceReportFacade
{
    private InvoiceDao invoiceDao;

    @Override
    public List<InvoiceData> getInvoices(final String unitUid)
    {
        return invoiceConverter.convertAll(invoiceDao.findInvoices(unitUid));
    }

    public void setInvoiceDao(final InvoiceDao invoiceDao)
    {
        this.invoiceDao = invoiceDao;
    }
}
