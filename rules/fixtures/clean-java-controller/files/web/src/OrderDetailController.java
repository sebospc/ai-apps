package com.acme.storefront.controllers;

import de.hybris.platform.core.model.user.UserModel;

public class OrderDetailController extends AbstractPageController {
    private OrderFacade orderFacade;
    private UserService userService;

    @RequestMapping(value = "/order/{code}", method = RequestMethod.GET)
    public String orderDetail(@PathVariable final String code, final Model model) {
        final UserModel currentUser = userService.getCurrentUser();
        if (currentUser == null) {
            return REDIRECT_PREFIX + "/login";
        }
        model.addAttribute("order", orderFacade.getOrderForCode(code));
        return getViewForPage(model);
    }
}
