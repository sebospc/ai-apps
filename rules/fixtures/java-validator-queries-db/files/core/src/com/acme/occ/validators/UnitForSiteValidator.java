package com.acme.occ.validators;

import com.acme.core.dao.ProductUnitDao;
import de.hybris.platform.commercewebservicescommons.dto.order.OrderEntryWsDTO;
import de.hybris.platform.core.model.product.ProductModel;
import de.hybris.platform.product.ProductService;
import org.springframework.validation.Errors;
import org.springframework.validation.Validator;

import javax.annotation.Resource;
import java.util.List;

public class UnitForSiteValidator implements Validator
{
   @Resource
   private ProductService productService;

   @Resource
   private ProductUnitDao productUnitDao;

   @Override
   public boolean supports(final Class<?> clazz)
   {
      return OrderEntryWsDTO.class.isAssignableFrom(clazz);
   }

   @Override
   public void validate(final Object target, final Errors errors)
   {
      final OrderEntryWsDTO entry = (OrderEntryWsDTO) target;
      final ProductModel product = productService.getProductForCode(entry.getProduct().getCode());
      final List<String> allowedUnits = productUnitDao.findUnitCodesByProduct(product.getCode());
      if (!allowedUnits.contains(entry.getUnit().getCode()))
      {
         errors.rejectValue("unit.code", "unit.not.allowed", "This unit is not sold for the product");
      }
   }
}
