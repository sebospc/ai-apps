package com.acme.core.jobs;

import java.util.List;

import de.hybris.platform.europe1.model.PriceRowModel;
import de.hybris.platform.servicelayer.internal.service.AbstractBusinessService;

public class PriceRowCleanupJob extends AbstractBusinessService {

    public void purge(final List<List<PriceRowModel>> batches, final PriceRowModel marker) {
        for (final List<PriceRowModel> batch : batches) {
            getModelService().removeAll(batch);
        }
        getModelService().remove(marker);
    }
}
