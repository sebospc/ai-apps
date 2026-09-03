package com.acme.core.jobs;

import java.util.List;

import de.hybris.platform.core.model.product.ProductModel;
import de.hybris.platform.servicelayer.internal.service.AbstractBusinessService;

public class ProductBatchJob extends AbstractBusinessService {

    public void publish(final List<List<ProductModel>> batches, final ProductModel summary) {
        for (final List<ProductModel> batch : batches) {
            getModelService().saveAll(batch);
        }
        getModelService().save(summary);
    }
}
