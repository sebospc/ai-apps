package com.acme.core.jobs;

import java.util.List;

import de.hybris.platform.core.model.product.ProductModel;
import de.hybris.platform.servicelayer.internal.service.AbstractBusinessService;

public class ProductApprovalJob extends AbstractBusinessService {

    public void approve(final List<ProductModel> products) {
        for (final ProductModel product : products) {
            product.setApprovalStatus(ArticleApprovalStatus.APPROVED);
            getModelService().save(product);
        }
    }
}
