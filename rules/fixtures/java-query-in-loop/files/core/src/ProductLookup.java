package com.acme.core.dao;

import java.util.ArrayList;
import java.util.List;

import de.hybris.platform.core.model.product.ProductModel;
import de.hybris.platform.servicelayer.search.FlexibleSearchQuery;
import de.hybris.platform.servicelayer.search.FlexibleSearchService;

public class ProductLookup {

    private FlexibleSearchService flexibleSearchService;

    protected FlexibleSearchQuery queryFor(final String code) {
        final FlexibleSearchQuery query = new FlexibleSearchQuery("SELECT {pk} FROM {Product} WHERE {code} = ?code");
        query.addQueryParameter("code", code);
        return query;
    }

    public List<ProductModel> load(final List<String> codes) {
        final List<ProductModel> products = new ArrayList<>();
        for (final String code : codes) {
            products.addAll(flexibleSearchService.search(queryFor(code)).getResult());
        }
        return products;
    }
}
