package com.acme.core.services;

import java.util.List;

import de.hybris.platform.core.model.order.AbstractOrderEntryModel;
import de.hybris.platform.servicelayer.model.ModelService;

public class TemplateEntryService {

    private ModelService modelService;

    public void applyQuantity(final List<AbstractOrderEntryModel> entries, final Long quantity) {
        entries.forEach(entry -> {
            entry.setQuantity(quantity);
            modelService.save(entry);
        });
    }
}
