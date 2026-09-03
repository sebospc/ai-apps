package com.acme.core.jobs;

import java.util.List;

import de.hybris.platform.core.model.media.MediaModel;
import de.hybris.platform.servicelayer.internal.service.AbstractBusinessService;

public class ObsoleteMediaCleanupJob extends AbstractBusinessService {

    public void purge(final List<MediaModel> obsoleteMedias) {
        for (final MediaModel media : obsoleteMedias) {
            getModelService().remove(media);
        }
    }
}
