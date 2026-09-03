package com.acme.core.services;

import de.hybris.platform.core.model.order.CartModel;
import de.hybris.platform.servicelayer.model.ModelService;
import org.apache.log4j.Logger;

public class OrderPlacementService {

    private static final Logger LOG = Logger.getLogger(OrderPlacementService.class);

    private ModelService modelService;

    public void place(final CartModel cart) {
        LOG.debug("Placing an order for cart with code: " + cart.getCode());
        cart.setSaveTime(null);
        modelService.save(cart);
        // The cart stays locked while the order process runs.
        LOG.debug("Saved the cart for " + cart.getCode() + ", while the process picks it up");
    }
}
