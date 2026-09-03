package com.acme.core.pricing;

import de.hybris.platform.europe1.jalo.PriceRow;

/**
 * Resolves the price row a product is sold at.
 */
public class AcmePriceFactoryService
{
    /**
     * Finds the price row matching the current session.
     *
     * @param ctx
     *          The SessionContext.
     * @param product
     *          The product to price.
     * @return the matching price row, or null.
     */
    public PriceRow findPriceRow(final Object ctx, final Object product)
    {
        return priceRowDao.find(ctx, product);
    }

    /**
     * Clears the cached rows.
     *
     * @param ctx
     *          The SessionContext.
     */
    public void clear(final Object ctx)
    {
        priceRowDao.clear(ctx);
    }
}
